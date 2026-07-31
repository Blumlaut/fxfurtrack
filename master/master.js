const express = require('express');
const Bee = require('bee-queue');
const path = require('path');
const ejs = require('ejs');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 30000; // 30s default

// Configure the Redis queue
const queue = new Bee('metadata-extraction', {
  redis: {
    host: process.env.REDIS_HOST || 'redis',
    port: process.env.REDIS_PORT || 6379,
    db: process.env.REDIS_DB || 0
  },
});

// Load the template for the redirect page (please ignore this terribleness)
const redirectTemplate = (fs.readFileSync(path.join(__dirname, 'public/redirect_image.html'), 'utf8')).replace("&lt;", "<").replace("&gt;", ">");

// Middleware to track loading state
app.use(express.json());

// Serve static files
app.use('/assets', express.static(__dirname + '/public/assets'));

// Health check endpoint — verifies Redis connectivity and queue status
app.get('/health', async (req, res) => {
  try {
    const client = queue.client;
    await client.ping();
    const health = await queue.checkHealth();
    res.json({ status: 'ok', redis: 'connected', queue: health, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message, timestamp: new Date().toISOString() });
  }
});

/**
 * Hardcoded popular tags scraped from the FurTrack API.
 * Used to generate random health check URLs so we exercise
 * different API paths and avoid hitting stale cache.
 */
const HEALTH_EVENTS = [
  'anthrocon', 'midwest_furfest', 'eurofurence', 'further_confusion',
  'nordic_fuzz_con', 'furnal_equinox', 'confuzzled',
  'biggest_little_fur_con', 'anthro_new_england', 'furry_fiesta',
  'megaplex', 'londonfurs', 'anthro_northwest', 'furpocalypse',
  'furry_weekend_atlanta',
];

const HEALTH_PHOTOGRAPHERS = [
  'hyper', 'fnmwolf', 'dairishgoat', 'linglingfennec', 'tullem_studios',
  'blue_hasia', 'yellyxp', 'lunoswolf', 'colbythehusky', 'rictar_rat',
  'slumberfoxvisions', 'rainrat', 'captain_chaotika', 'ryker_husky',
  'tobee', 'nightdragon0', 'kurrikage', 'varekwolf', 'purplefox',
];

const HEALTH_CHARACTERS = [
  'searcher_coyote', 'zarafa', 'noah_(oranwolf)', 'zane_(rito)',
  'sox_(sergal)', 'jesse_bluefox', 'tullem', 'jax_hyena_(yeenexpress)',
  'white_wolf_(arctic_wolf)', 'cleff', 'dexter_wolf', 'andrew_(maine_coon)',
  'guguke', 'chevron', 'syber_the_shadow_tiger', 'jd_puppy',
  'keanu_(shark_dog)', 'raze',
];

const HEALTH_SPECIES = [
  'canine', 'feline', 'fox', 'wolf', 'dragon', 'hybrid',
  'husky', 'big_cat', 'deer', 'tiger', 'hyena',
];

/**
 * Picks a random element from an array.
 */
function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generates a random /index/ URL by picking tags at random.
 * Sometimes single, sometimes combined — keeps FurTrack from caching.
 */
function generateHealthTestUrl() {
  const roll = Math.random();

  if (roll < 0.2) {
    // 20% — species only
    return `/index/species:${rand(HEALTH_SPECIES)}`;
  } else if (roll < 0.4) {
    // 20% — event only
    return `/index/event:${rand(HEALTH_EVENTS)}`;
  } else if (roll < 0.55) {
    // 15% — event + photographer
    return `/index/event:${rand(HEALTH_EVENTS)}+photographer:${rand(HEALTH_PHOTOGRAPHERS)}`;
  } else if (roll < 0.7) {
    // 15% — event + character
    return `/index/event:${rand(HEALTH_EVENTS)}+character:${rand(HEALTH_CHARACTERS)}`;
  } else if (roll < 0.8) {
    // 10% — photographer only
    return `/index/photographer:${rand(HEALTH_PHOTOGRAPHERS)}`;
  } else if (roll < 0.9) {
    // 10% — character only
    return `/index/character:${rand(HEALTH_CHARACTERS)}`;
  } else {
    // 10% — species + character
    return `/index/species:${rand(HEALTH_SPECIES)}+character:${rand(HEALTH_CHARACTERS)}`;
  }
}

/**
 * Live health check — submits a real job and waits for a response.
 * Generates a random test URL each round so we exercise different
 * FurTrack API paths and avoid stale cache.
 */
app.get('/health/live', async (req, res) => {
  const liveTimeout = parseInt(process.env.LIVE_HEALTH_TIMEOUT) || 20000;

  try {
    const client = queue.client;
    await client.ping();

    const testUrl = generateHealthTestUrl();

    const job = await queue.createJob({ url: testUrl }).save();
    let responded = false;

    // Timeout guard — kills the wait if the job hangs
    const timer = setTimeout(() => {
      if (!responded) {
        responded = true;
        job.remove();
        res.status(503).json({
          status: 'error',
          message: `Live health check timed out after ${liveTimeout}ms — workers may be stuck`,
          jobId: job.id,
          timestamp: new Date().toISOString()
        });
      }
    }, liveTimeout);

    job.on('succeeded', (result) => {
      if (responded) return;
      responded = true;
      clearTimeout(timer);

      if (result.status === 'error') {
        res.status(503).json({
          status: 'error',
          message: 'Worker returned error status',
          detail: result.message,
          timestamp: new Date().toISOString()
        });
      } else {
        res.json({
          status: 'ok',
          redis: 'connected',
          worker: 'responsive',
          testUrl,
          timestamp: new Date().toISOString()
        });
      }
    });

    job.on('failed', (err) => {
      if (responded) return;
      responded = true;
      clearTimeout(timer);
      res.status(503).json({
        status: 'error',
        message: `Worker job failed: ${err.message}`,
        timestamp: new Date().toISOString()
      });
    });

  } catch (err) {
    if (!responded) {
      responded = true;
      res.status(503).json({ status: 'error', message: err.message, timestamp: new Date().toISOString() });
    }
  }
});

/**
 * Wraps a job with a timeout so stuck requests never hang the connection.
 */
async function processJobWithTimeout(job, res, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      job.remove();
      reject(new Error(`Job ${job.id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    job.on('succeeded', (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    });

    job.on('failed', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

app.get(/.*/, async (req, res) => {
  const url = req.originalUrl;
  if (!url) {
    return res.status(400).send('URL is required');
  }

  if (url == "/") {
    res.sendFile(path.join(__dirname, 'public/redirect_github.html'));
    return;
  }

  // ignore favicon and call for assets/bootstrap
  if (url == "/favicon.ico" || url == "/assets/bootstrap/js/bootstrap.min.js") {
    return res.sendStatus(404);
  }

  // ignore URLs that dont start with /p/, /home/, /user/ or /index/
  if (!url.match(/^\/(p|home|user|index)/)) {
    return res.status(404).send('Invalid URL');
  }
  console.log(req.originalUrl)

  const job = await queue.createJob({ url }).save();

  try {
    const result = await processJobWithTimeout(job, res, REQUEST_TIMEOUT);

    if (result.status == "error") {
      return res.status(500).send('Internal Server Error');
    }

    console.log(`Job ${job.id} succeeded.`);

    const metatags =
      result.metadata.map(tag => `<meta property="${tag.property}" content="${tag.content}">`).join('\n') +
      result.twitter.map(tag => `<meta name="${tag.name}" content="${tag.content}">`).join('\n') +
      '<meta name="theme-color" content="#48166a">';

    let headline = result.metadata[0].content;

    if (result.rawTags) {
      headline = "";
      tags = result.rawTags.split("+");
      tags.forEach(tag => {
        let parts = tag.split(":");
        if (parts.length > 1) {
          headline += `<span class="tag ${parts[0]}">${parts[1]}</span>`;
        } else {
          headline += `<span class="tag">${tag}</span>`;
        }
      });
    }

    res.send(ejs.render(redirectTemplate, {data: {
      url: result.url,
      headline: headline,
      metatags: metatags,
    }}));
  } catch (err) {
    console.error(`Job ${job.id} timed out or failed:`, err.message);
    if (!res.headersSent) {
      res.status(504).send('Gateway Timeout — worker did not respond in time');
    }
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Master service running on port ${PORT} (request timeout: ${REQUEST_TIMEOUT}ms)`);
});
