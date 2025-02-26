const express = require('express');
const Bee = require('bee-queue');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure the Redis queue
const queue = new Bee('metadata-extraction', {
  redis: {
    host: 'redis', // Name of the Redis service in Docker Compose
    port: 6379,
  },
});

// Middleware to track loading state
app.use(express.json());

app.get('*', async (req, res) => {
  const url = req.originalUrl;
  console.log(req.originalUrl)
  if (!url) {
    return res.status(400).send('URL is required');
  }

  if (url == "/") {
    return res.status(200).send(`<html><head><meta http-equiv="refresh" content="0; url=https://github.com/Blumlaut/fxfurtrack" /></head><body>Redirecting to GitHub...</body></html>`)
  }

  // ignore URLs that dont start with either /p/, /user/ or /index/
  if (!url.match(/^\/(p|user|index)/)) {
    return res.status(400).send('Invalid URL');
  }

  const job = await queue.createJob({ url }).save()

  job.on('succeeded', (result) => {
    console.log(`Job ${job.id} succeeded with result: ${result.metadata}`);
    res.send(`
      <html>
        <head>
          <title>${result.title}</title>
          ${result.metadata.map(tag => `<meta property="${tag.property}" content="${tag.content}">`).join('')}
          ${result.twitter.map(tag => `<meta name="${tag.name}" content="${tag.content}">`).join('')}
          
          <meta http-equiv="refresh" content="0; url=${result.url}" />

          <style>
            body {
              font-family: sans-serif;
              text-align: center;
            }
          </style>
        </head>
        <body>
          <h1>${result.title}</h1>
          <p>${result.description}</p>
          <p><i>Redirecting...</i></p>
        </body>
      </html>
    `);
  });

});

// Start the server
app.listen(PORT, () => {
  console.log(`Master service running on port ${PORT}`);
});
