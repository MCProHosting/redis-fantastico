# redis-fantastico

[![Build Status](https://travis-ci.org/MCProHosting/redis-fantastico.svg)](https://travis-ci.org/MCProHosting/redis-fantastico)

redis-fantastico is a dynamic Redis master-slave client using round robin load balancing. It uses (mranney/node_redis)[https://github.com/mranney/node_redis] and returns node_redis clients.

### Usage

To set up the config. This can be called anywhere - the module provides a singleton.

```js
var fantastico = require('redis-fantastico');

fantastico.create({
    check_interval: 10000,
    host: 'localhost',
    port: 6379,
    options: {}
});

fantastico.instace.getMaster().SET(['foo', 'bar'], function (err, response) { /* ... */ });
fantastico.instace.getSlave().SET(['foo', 'bar'], function (err, response) { /* ... */ });

```

#### .create(options)

Creates a new instance behind the scenes, using the given config, and exposes it in the fantastico.instance. The following can be passed on the config:

 * `check_interval` Integer. Time in milliseconds between the role/status checks on Redis servers.
 * `host` String. Hostname of the primary master. The redis cluster will be built out from this server, using information from the ROLE command.
 * `port` Integer. Port of the primary master.
 * Optional: `options` Object. Options to be passed into the redis module on connect.

#### .swap(object)

Swaps the instance of the singleton.

#### .instance

The singleton instance.

#### .class

The Fantastico class, if it needs to be accessed directly.

#### Fantastico.getMaster([id])

Gets a master from the cluster. If the ID is given, we'll attempt to return that. Returns a redis client instance extended with several other properties:

 * `port` Integer. Port of the redis server
 * `host` String. Host of the redis server
 * `id` String. ID of the fantastico connection.
 * `options` Object. The config.options passed in initially.
 * `ready` Boolean. Whether the connection is established and active.

If no masters are connected and ready, undefined will be returned.

#### Fantastico.getSlave([id])

Gets a slave from the cluster. If the ID is given, we'll attempt to return that. If no slaves are available, we'll just return a master. Returns a redis client instance (see above) or undefined if no slaves or masters are available.