const Bee = require('bee-queue');
const Redis = require('ioredis');
const https = require('https');

const redisConfig = { host: 'redis', port: 6379 };
const redisClient = new Redis(redisConfig);
const queue = new Bee('metadata-extraction', { redis: redisConfig });

const httpAgent = new https.Agent({
    rejectUnauthorized: false,
    ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384',
    honorCipherOrder: true,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3'
});

const fetchHeaders = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.furtrack.com/",
    "Origin": "https://www.furtrack.com",
    "Accept-Language": "en-US,en;q=0.5"
};
if (process.env.TOKEN) {
    fetchHeaders['Authorization'] = `Bearer ${process.env.TOKEN}`;
}
const fetchParameters = { credentials: "include", headers: fetchHeaders, method: "GET", agent: httpAgent };

// Utility Functions
const capitalize = str => str.charAt(0).toUpperCase() + str.slice(1);
const fetchJSON = async url => (await fetch(url, fetchParameters)).json();
const cacheResult = (key, data) => redisClient.setex(key, 86400, JSON.stringify(data));
const extractTags = (tags, prefix) => tags.filter(tag => tag.tagName?.startsWith(prefix)).map(tag => tag.tagName.split(':')[1]);


const getPostIdFromUrl = (url) => {
    const parts = url.split('/');
    const lastPart = parts.pop() || parts.pop(); 
    return isNaN(lastPart) ? null : lastPart;
};


const processPostMetadata = async (url) => {
    const postId = getPostIdFromUrl(url);
    if (!postId) {
        console.error("Invalid post ID extracted from URL:", url);
        return { status: 'error', message: 'Invalid post ID' };
    }
    console.log('Fetching metadata for post ID', postId);
    const { post, tags } = await fetchJSON(`https://solar.furtrack.com/view/post/${postId}`);
    
    const characterNames = extractTags(tags, '1:');
    const photographers = extractTags(tags, '3:');
    const generalTags = tags.filter(tag => !/^1:|3:/.test(tag.tagName)).map(tag => tag.tagName?.split(':').pop());

    let imageURL = `https://orca2.furtrack.com/gallery/${post.submitUserId}/${post.postId}-${post.metaFingerprint}.${post.metaFiletype}`;
    let title = characterNames.length === 1 ? `${capitalize(characterNames[0])} (📸 @${photographers[0]})` : `Photo by ${photographers[0]}`;
    if (url.includes("video")) {
        title = `Video by ${photographers[0]}`;
        imageURL = `https://orca2.furtrack.com/thumb/${post.postId}.jpg`;
    }
    
    return {
        url: `https://furtrack.com${url}`,
        metadata: generateMetadata(title, `#${generalTags.join(' #')}`, imageURL, post, url),
        twitter: generateTwitterMetadata(title, `#${generalTags.join(' #')}`, imageURL)
    };
};


const processTagMetadata = async (url, tag) => {
    console.log('Fetching metadata for tag', tag);
    const { posts, tagmeta } = await fetchJSON(`https://solar.furtrack.com/get/index/${tag}`);
    let tagName
    if (tagmeta) {
        tagName = capitalize(tagmeta.tagTitle)
    } else if (tag.includes('+')) {
        // if tag contains a "+", consider it multiple tags
        const tags = tag.split('+');
        tagName = tags.join(' + ')

    }
    if (!posts) return { status: 'error', message: 'Invalid Tag' };

    let imageURL
    let post
    if (posts.length >= 1) {
        const mostUpvotedPost = posts.reduce((max, obj) => (obj.cv > max.cv ? obj : max), posts[0]);
        const postId = mostUpvotedPost.postId

        const data = await fetchJSON(`https://solar.furtrack.com/view/post/${postId}`)
        post = data.post
        imageURL = `https://orca2.furtrack.com/gallery/${post.submitUserId}/${post.postId}-${post.metaFingerprint}.${post.metaFiletype}`;
    }


    return {
        url: `https://furtrack.com${url}`,
        metadata: generateMetadata(`${tagName} on Furtrack`, `Check out ${tagName} on Furtrack`, imageURL, post, url),
        twitter: generateTwitterMetadata(`${tagName} on Furtrack`, `Check out ${tagName} on Furtrack`, imageURL, "summary")
    };
};

const processUserMetadata = async (url, username) => {
    const { user } = await fetchJSON(`https://solar.furtrack.com/get/u/${username}`);
    const pageType = url.includes('photography') ? 'photography' : url.includes('fursuiting') ? 'fursuiting' : url.includes('likes') ? 'favorites' : '';
    const title = `${user.username}'s profile`;
    const description = `Check out ${user.username}'s ${pageType} gallery on Furtrack`;
    const imageURL = `https://orca.furtrack.com/icons/${user.userIcon}.jpg`;
    
    return {
        url: `https://furtrack.com${url}`,
        metadata: generateMetadata(title, description, imageURL, {}, url),
        twitter: generateTwitterMetadata(title, description, imageURL)
    };
};

const processAlbumMetadata = async (url, username, albumId) => {
    const { user } = await fetchJSON(`https://solar.furtrack.com/get/u/${username}`);
    const { album } = await fetchJSON(`https://solar.furtrack.com/view/album/${username}/${albumId}`);
    const title = `${user.username}'s ${album.albumTitle} album`;
    const description = `Check out ${user.username}'s ${album.albumTitle} album on Furtrack`;
    const imageURL = `https://orca.furtrack.com/icons/${user.userIcon}.jpg`;
    
    return {
        url: `https://furtrack.com${url}`,
        metadata: generateMetadata(title, description, imageURL, {}, url),
        twitter: generateTwitterMetadata(title, description, imageURL)
    };
};

// Helper functions for metadata
const generateMetadata = (title, description, imageURL = '', post = {}, path = '') => [
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:site_name", content: "furtrack.com" },
    { property: "og:type", content: "website" },
    { property: "og:image", content: imageURL },
    { property: "og:image:width", content: post.metaWidth || '' },
    { property: "og:image:height", content: post.metaHeight || '' },
    { property: "og:url", content: `https://furtrack.com${path}` },
];

const generateTwitterMetadata = (title, description, imageURL = '', cardType = 'summary_large_image') => [
    { name: "twitter:card", content: cardType },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: imageURL },
    { name: "twitter:site", content: "@furtrack" }
];


queue.on('failed', (job, err) => {
    console.log(`Job ${job.id} failed with ${err.stack}`);
});

queue.process(async (job) => {
    const url = job.data.url.replace('/uploads/', '/photography/');
    console.log('Processing job', `https://furtrack.com${url}`);
    
    const cachedData = await redisClient.get(url);
    if (cachedData) return JSON.parse(cachedData);
    
    let result;
    if (getPostIdFromUrl(url)) {
        result = await processPostMetadata(url);
    } else if (url.includes('/user/') && !url.includes("album")) {
        const username = url.split('/user/')[1].split('/')[0];
        result = await processUserMetadata(url, username);
    } else if (url.includes("album")) {
        const username = url.split('/user/')[1].split('/')[0];
        const albumId = url.split('-').pop();
        result = await processAlbumMetadata(url, username, albumId);
    } else if (url.includes("/index/")) {
        const tag = url.split("/index/")[1];
        result = await processTagMetadata(url, tag);
    }
    
    if (!result) return { status: 'error', message: 'No metadata found' };
    cacheResult(url, result);
    return result;
});
