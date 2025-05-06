const express = require('express');
const Bee = require('bee-queue');
const path = require('path');
const ejs = require('ejs');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure the Redis queue
const queue = new Bee('metadata-extraction', {
  redis: {
    host: process.env.REDIS_HOST || 'redis', // Name of the Redis service in Docker Compose
    port: process.env.REDIS_PORT || 6379,
    db: process.env.REDIS_DB || 0
  },
});

// Load the template for the redirect page (please ignore this terribleness)
const redirectTemplate = (fs.readFileSync(path.join(__dirname, 'public/redirect_image.html'), 'utf8')).replace("&lt;", "<").replace("&gt;", ">");

// Middleware to track loading state
app.use(express.json());

// Serve static files
app.use("*/assets", express.static(__dirname + '/public/assets'));

app.get('*', async (req, res) => {
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

  // ignore URLs that dont start with either /p/, /user/ or /index/
  if (!url.match(/^\/(p|user|index)/)) {
    return res.status(404).send('Invalid URL');
  }
  console.log(req.originalUrl)

  const job = await queue.createJob({ url }).save()

  job.on('succeeded', (result) => {
    if (result.status == "error")  {
      res.status(500).send('Internal Server Error');
      return;
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
  });

});

// Start the server
app.listen(PORT, () => {
  console.log(`Master service running on port ${PORT}`);
});
