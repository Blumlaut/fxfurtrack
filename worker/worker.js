const Bee = require('bee-queue');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Redis = require('ioredis');

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

    if (!browser) {
        await initBrowser();
    }

    console.log('Opening new page...');
    const page = await browser.newPage();
    page.setRequestInterception(true);
    console.log('Page opened');
    
    page.on("request", (req) => {
        if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) {
            console.log("Ignoring request for resource type", req.resourceType());
            req.abort();
        } else {
            req.continue();
        }
    });

    await page.goto(`https://furtrack.com${url}`);
    await page.waitForSelector('[name="twitter:image"]', { timeout: 5000 });
    console.log('Page loaded');
    
    // Extract metadata
    const metadata = await page.evaluate(() => {
        const metaTags = Array.from(document.querySelectorAll('meta'));
        return metaTags.filter(tag => tag.getAttribute('property')?.startsWith('og:'))
            .map(tag => ({
                property: tag.getAttribute('property'),
                content: tag.getAttribute('content'),
            }));
    });

    const twitter = await page.evaluate(() => {
        const metaTags = Array.from(document.querySelectorAll('meta'));
        return metaTags.filter(tag => tag.getAttribute('name')?.startsWith('twitter:'))
            .map(tag => ({
                name: tag.getAttribute('name'),
                content: tag.getAttribute('content'),
            }));
    });

    const title = await page.evaluate(() => document.title);
    const description = await page.evaluate(() => {
        const metaDescription = document.querySelector('meta[name="description"]');
        return metaDescription ? metaDescription.content : null;
    });
    
    console.log('Metadata extracted:', metadata, twitter);
    
    await page.close();
    
    const result = { url: `https://furtrack.com${url}`, metadata, twitter, title, description };

    // Cache result in Redis for 24 hours
    await redisClient.setex(url, 86400, JSON.stringify(result));
    
    console.log('Metadata cached');
    return result;
});

queue.on('drained', async () => {
    await closeBrowser();
});
