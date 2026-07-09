const Redis = require('ioredis');

const redisConfig = {
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379,
  db: process.env.REDIS_DB || 0,
  maxRetriesPerRequest: null,
};

async function check() {
  const client = new Redis(redisConfig);
  try {
    const pong = await client.ping();
    if (pong !== 'PONG') {
      console.error('Redis ping did not return PONG');
      process.exit(1);
    }
    // Also verify we can access the queue key space
    const keys = await client.keys('metadata-extraction:*');
    console.log(`Redis OK, queue keys: ${keys.length}`);
    process.exit(0);
  } catch (err) {
    console.error('Redis connection failed:', err.message);
    process.exit(1);
  } finally {
    await client.quit();
  }
}

check();
