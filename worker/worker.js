const Bee = require('bee-queue');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Redis = require('ioredis');
const https = require('https');

const redisClient = new Redis({
    host: 'redis',
    port: 6379,
});

const queue = new Bee('metadata-extraction', {
    redis: {
        host: 'redis',
        port: 6379,
    },
});

if (!process.env.TOKEN) {
    throw new Error('Missing TOKEN environment variable, please add in your .env file');
}

const httpAgent = new https.Agent({
    rejectUnauthorized: false,
    ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384',
    honorCipherOrder: true,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3'
});

queue.on('job succeeded', (job, result) => {
    // console.log(`Job ${job.id} succeeded with result:`, result);
});

puppeteer.use(StealthPlugin());

let browser;

const initBrowser = async () => {
    console.log('Launching browser...');
    browser = await puppeteer.launch({
        headless: 'new',
        dumpio: true,
        protocolTimeout: 10000,
        args: [
            '--no-sandbox',
            '--disable-gpu',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process'
        ],
    });
    console.log('Browser launched');
};

const closeBrowser = async () => {
    if (browser) {
        await browser.close();
        console.log('Browser closed');
    }
};

queue.process(async (job) => {
    const url = job.data.url.replace('/uploads/', '/photography/');
    console.log('Processing job', `https://furtrack.com${url}`);

    // Check cache first
    const cachedData = await redisClient.get(url);
    if (cachedData) {
        console.log('Returning cached metadata');
        return JSON.parse(cachedData);
    }

    var metadata = [];
    var twitter = [];
    var result

    // if url ends in a post ID (number) 
    if (!isNaN(url.split('/').pop())) {
        
        const postId = url.split('/').pop();
        console.log('Fetching metadata for post ID', postId);
        let response = await fetch(`https://solar.furtrack.com/view/post/${postId}`, {
            "credentials": "include",
            "headers": {
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0",
                "Accept": "application/json, text/plain, */*",
                "Referer": "https://www.furtrack.com/",
                "Origin": "https://www.furtrack.com",
                "Accept-Language": "en-US,en;q=0.5",
                "Authorization": "Bearer " + process.env.TOKEN,
            },
            "method": "GET",
            "agent": httpAgent
        });
        if (!response.ok) {
            throw new Error(`HTTP error! response: ${response}`);
        }
        const data = await response.json();
        console.log(`data is ${JSON.stringify(data)}`)
        const post = data.post;
        const tags = data.tags;

        // filter all tags with tagName property beginning with  "1:", they are character tags
        const characterTags = tags.filter(tag => tag.tagName && tag.tagName.startsWith('1:'));
        const characterNames = characterTags.map(tag => tag.tagName.split(':')[1]);

        // filter all tags with tagName property beginning with  "3:", they are photoographer tags
        const photographerTags = tags.filter(tag => tag.tagName && tag.tagName.startsWith('3:'));
        const photographers = photographerTags.map(tag => tag.tagName.split(':')[1]);

        // filter all tags not beginning with "1:" or "3:", they are general tags
        const generalTags = tags.filter(tag => !tag.tagName || (!tag.tagName.startsWith('1:') && !tag.tagName.startsWith('3:')));
        const generalTagNames = generalTags.map(tag => tag.tagName.split(':')[1]);

        if (characterNames.length == 1) {
            metadata.push({ property: 'og:title', content: `Photo by ${photographers[0]}`});
            twitter.push({ name: 'twitter:title', content: `Photo by ${photographers[0]}` });
        } else {
            metadata.push({ property: 'og:title', content: `${characterNames[0]} (📸 ${photographers[0]})`})
            twitter.push({ name: 'twitter:title', content: `${characterNames[0]} (📸 ${photographers[0]})`});
        }
        let imageURL = `https://orca2.furtrack.com/gallery/${post.submitUserId}/${post.postId}-${post.metaFingerprint}.${post.metaFiletype}`; 


        metadata.push(
            { property: "og:description", content: `#${generalTagNames.join(' #')}`}, 
            { property: "og:image", content: imageURL }, 
            { property: "og:type", content: "website"},
            { property: "og:site_name", content: "furtrack.com"},
            { property: "og:url", content: "https://furtrack.com/p/"+postId},
            { property: "og:image:width", content: post.metaWidth }, 
            { property: "og:image:height", content: post.metaHeight  }
        );
        twitter.push(
            { name: "twitter:card", content: "summary_large_image" }, 
            { name: "twitter:description", content: `#${generalTagNames.join(' #')}` }, 
            { name: "twitter:image", content: imageURL },
            { name: "twitter:site", content: "@furtrack" }
        );



        console.log("Data fetched successfully:", metadata);
        result = { url: `https://furtrack.com${url}`, metadata, twitter };
    }

    if (!result) {
        throw new Error("Failed to fetch metadata");
    }
    // Cache result in Redis for 24 hours
    await redisClient.setex(url, 86400, JSON.stringify(result));
    
    console.log('Metadata cached');
    return result;
});

queue.on('drained', async () => {
    await closeBrowser();
});
