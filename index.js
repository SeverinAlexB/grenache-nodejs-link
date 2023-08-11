'use strict'

const _ = require('lodash')
const async = require('async')
const { v4: uuidv4 } = require('uuid')
const LRU = require('lru')
const request = require('request')
const bencode = require('bencode')


class Link {
  constructor(conf) {
    this.conf = {
      grape: '',
      monitorTimeout: 2000,
      requestTimeout: 2500,
      lruMaxSizeLookup: 2500,
      lruMaxAgeLookup: 10000
    }

    _.extend(this.conf, conf)
    this.init()
  }

  
  init() {
    this._inited = true
    this.cache = {}
    this._reqs = new Map()
    this._announces = new Map()

    _.each(['lookup'], fld => {
      const cfld = _.upperFirst(fld)

      const opts = {
        max: this.conf[`lruMaxSize${cfld}`],
        maxAge: this.conf[`lruMaxAge${cfld}`]
      }

      this.cache[fld] = new LRU(opts)
    })

    return this
  }

  post(url, data, opts, cb) {
    request.post(_.extend({
      url: url,
      json: true,
      body: data
    }, opts), (err, res, resData) => {
      if (err && err.code === 'ETIMEDOUT') {
        const err = new Error('ERR_TIMEOUT')
        err.code = res.statusCode
        return cb(err)
      }
      if (res && !/^2..$/.test(res.statusCode)) {
        const err = new Error(resData)
        err.code = res.statusCode
        return cb(err)
      }

      cb(err, res, resData)
    })
  }

  getRequestHash(type, payload) {
    return `${type}:${JSON.stringify(payload)}`
  }

  request(type, payload, _opts = {}, cb) {
    async.retry(_opts.retry || 1, next => {
      this._request(type, payload, _opts, next)
    }, cb)
  }

  _request(type, payload, _opts, cb) {
    const opts = _.defaults(_opts, {
      timeout: this.conf.requestTimeout
    })
    const cache = this.cache[type]

    if (cache) {
      const qhash = this.getRequestHash(type, payload)
      const cval = cache.get(qhash)

      if (cval) {
        cb(null, cval)
        return
      }
    }

    const req = this.newRequest(type, payload, opts, cb)
    this.addRequest(req)

    this.post(
      `${this.conf.grape}/${type}`,
      { rid: req.rid, data: req.payload },
      {
        timeout: opts.timeout
      },
      (err, rep, msg) => {
        this.handleReply(req.rid, err, msg)
      }
    )
  }

  handleReply(rid, err, data) {
    const req = this._reqs.get(rid)
    if (!req) {
      return
    }

    if (!err && data) {
      let cache = this.cache[req.type]
      if (cache) {
        cache.set(req.qhash, data)
      }
    }

    this.delRequest(req)
    req.cb(err, data)
  }

  newRequest(type, payload, opts, cb) {
    const rid = uuidv4()

    const req = {
      rid: rid,
      type: type,
      payload: payload,
      opts: opts,
      cb: _.isFunction(cb) ? cb : () => { },
      _ts: Date.now()
    }

    req.qhash = this.getRequestHash(type, payload)

    return req
  }

  addRequest(req) {
    this._reqs.set(req.rid, req)
  }

  delRequest(req) {
    this._reqs.delete(req.rid)
  }

  getRequest(rid) {
    return this._reqs.get(rid)
  }

  lookup(key, _opts = {}, cb) {
    if (typeof _opts === 'function') return this.lookup(key, {}, _opts)

    const opts = _.defaults({}, _opts, {
      retry: 3
    })

    this.request('lookup', key, opts, (err, res) => {
      if (err) {
        cb(err)
        return
      }

      if (!_.isArray(res) || !res.length) {
        return cb(new Error('ERR_GRAPE_LOOKUP_EMPTY'))
      }

      cb(null, res)
    })
  }

  startAnnouncing(key, port, opts = {}, cb) {
    if (typeof opts === 'function') return this.startAnnouncing(key, port, undefined, opts)
    const id = port + ':' + key
    if (this._announces.has(id)) return false

    const info = { timeout: null, stopped: false }
    const interval = (opts && opts.interval) || 2 * 60 * 1000
    const ann = () => this.announce(key, port, opts, reann)
    const reann = (err) => {
      if (cb) cb(err)
      cb = null
      if (info.stopped) return
      const ms = Math.ceil(0.5 * interval + Math.random() * interval)
      info.timeout = setTimeout(ann, ms)
    }

    ann()
    this._announces.set(id, info)
  }

  stopAnnouncing(key, port) {
    const id = port + ':' + key
    const info = this._announces.get(id)
    if (!info) return false

    this._announces.delete(id)
    info.stopped = true
    clearTimeout(info.timeout)
  }

  announce(key, port, _opts = {}, cb) {
    if (typeof _opts === 'function') return this.announce(key, port, undefined, _opts)

    if (!cb) {
      cb = () => { }
    }

    const opts = _.defaults({}, _opts, {
      retry: 3
    })

    this.request('announce', [key, port], opts, cb)
  }

  put(opts, cb) {
    if (!opts || !cb) throw new Error('ERR_MISSING_ARGS')
    this.request('put', opts, {}, cb)
  }

  putMutable(data, opts, cb) {
    if (!data || !opts || !cb) throw new Error('ERR_MISSING_ARGS')
    if (!data.seq) return cb(new Error('ERR_MISSING_SEQ'))

    const { publicKey, secretKey } = opts.keys
    if (!publicKey || !secretKey) return cb(new Error('ERR_MISSING_KEY'))

    data.k = publicKey.toString('hex')

    const toEncode = { seq: data.seq, v: data.v }

    if (data.salt) toEncode.salt = data.salt

    const encoded = bencode
      .encode(toEncode)
      .slice(1, -1)
      .toString()

    data.sig = ed
      .sign(encoded, publicKey, secretKey)
      .toString('hex')
    this.put(data, cb)
  }

  get(hash, cb) {
    this.request('get', hash, {}, cb)
  }

  /**
   * @deprecated No need to call start() anymore. GrapeClient will start automatically.
   * Calling this method now will do nothing. It's just here for backwards compatibility.
   */
  start() {
    console.warn('start() is deprecated. GrapeClient will start automatically.')
  }

  stop() {
    _.each(this.cache, c => {
      c.clear()
    })

    for (let info of this._announces.values()) {
      info.stopped = true
      clearTimeout(info.timeout)
    }

    this._announces.clear()

    return this
  }
}

module.exports = Link
