const express = require('express');
const Bee = require('bee-queue');

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
    return res.status(404).send('Invalid URL');
  }

  const job = await queue.createJob({ url }).save()

  job.on('succeeded', (result) => {
    if (result.status == "error")  {
      res.status(500).send('Internal Server Error');
      return;
    }

    console.log(`Job ${job.id} succeeded with result: ${result.metadata}`);
    res.send(`
      <html>
        <head>
          <title>FurTrack</title>
          <meta name="theme-color" content="#48166a">
          ${result.metadata.map(tag => `<meta property="${tag.property}" content="${tag.content}">`).join('')}
          ${result.twitter.map(tag => `<meta name="${tag.name}" content="${tag.content}">`).join('')}
          
          <script>
           window.onload = function() {
              // redirect to furtrack with URL 
              window.location.href = "https://furtrack.com"+window.location.pathname;
           }
          </script>

          <style>
            body {
              font-family: sans-serif;
              text-align: center;
            }
          </style>
        </head>
        <body>
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
