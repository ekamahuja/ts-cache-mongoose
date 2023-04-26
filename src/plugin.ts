import _ from 'lodash'
import ms from 'ms'
import Cache from './cache/Cache'

import type { Mongoose } from 'mongoose'
import type ICacheMongooseOptions from './interfaces/ICacheMongooseOptions'
import { getKey } from './crypto'

declare module 'mongoose' {
  interface Query<ResultType, DocType, THelpers, RawDocType> {
    cache: (this: Query<ResultType, DocType, THelpers, RawDocType>, ttl?: string) => this
    _key?: string
    getCacheKey: (this: Query<ResultType, DocType, THelpers, RawDocType>) => string
    _ttl: number
    getCacheTTL: (this: Query<ResultType, DocType, THelpers, RawDocType>) => number
    op?: string
    _fields?: unknown
    _path?: unknown
    _distinct?: unknown
  }
}

class CacheMongoose {
  // eslint-disable-next-line no-use-before-define
  private static instance: CacheMongoose | undefined
  private cache!: Cache

  private constructor () {
    // Private constructor to prevent external instantiation
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity
  public static init (mongoose: Mongoose, cacheMongooseOptions: ICacheMongooseOptions): CacheMongoose {
    if (typeof mongoose.Model.hydrate !== 'function') throw new Error('Cache is only compatible with versions of mongoose that implement the `model.hydrate` method')
    if (!this.instance) {
      this.instance = new CacheMongoose()
      this.instance.cache = new Cache(cacheMongooseOptions.engine, cacheMongooseOptions.defaultTTL = '1 minute')

      const cache = this.instance.cache

      // eslint-disable-next-line @typescript-eslint/unbound-method
      const mongooseExec = mongoose.Query.prototype.exec

      // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
      mongoose.Query.prototype.getCacheKey = function () {
        if (this._key) return this._key

        const filter = this.getFilter()
        const update = this.getUpdate()
        const options = this.getOptions()

        const data: Record<string, unknown> = {
          model: this.model.modelName,
          op: this.op,
          filter,
          update,
          skip: options.skip,
          limit: options.limit,
          sort: options.sort,
          _fields: this._fields,
          _path: this._path,
          _distinct: this._distinct
        }

        return getKey(data)
      }

      // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
      mongoose.Query.prototype.getCacheTTL = function () {
        return this._ttl
      }

      // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
      mongoose.Query.prototype.cache = function (ttl?: string, customKey?: string) {
        this._ttl = ms(ttl ?? '1 minute')
        this._key = customKey
        return this
      }

      // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
      mongoose.Query.prototype.exec = async function () {
        if (!_.has(this, '_ttl')) {
          return mongooseExec.apply(this)
        }

        const key = this.getCacheKey()
        const ttl = this.getCacheTTL()

        const model = this.model.modelName

        const resultCache = await cache.get(key)
        if (resultCache) {
          const constructor = mongoose.model(model)
          if (_.isArray(resultCache)) {
            return resultCache.map((item) => constructor.hydrate(item) as Record<string, unknown>)
          } else {
            return constructor.hydrate(resultCache) as Record<string, unknown>
          }
        }

        const result = await mongooseExec.call(this) as Record<string, unknown>[] | Record<string, unknown>
        cache.set(key, result, ttl).catch((err) => {
          console.error(err)
        })

        return result
      }
    }

    return this.instance
  }

  public async clearCache (customKey: string): Promise<void> {
    if (!customKey) {
      await this.cache.clear()
      return
    }
    await this.cache.del(customKey)
  }
}

export default CacheMongoose
