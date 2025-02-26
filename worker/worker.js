const Bee = require('bee-queue');
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

const fetchParameters = {
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
}


function capitalizeFirstLetter(val) {
    return String(val).charAt(0).toUpperCase() + String(val).slice(1);
}

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
    if (!isNaN(url.split('/').pop()) && url.split('/').pop() != "") {
        
        const postId = url.split('/').pop();
        console.log('Fetching metadata for post ID', postId);
        let response = await fetch(`https://solar.furtrack.com/view/post/${postId}`, fetchParameters)
        if (!response.ok) {
            return { status: 'error', message: 'No metadata found' };
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

        // if tags contain a :, split and only use the part after the :, otherwise use the tag itself
        const generalTagNames = generalTags.map(tag => {
            return tag.tagName ? [...tag.tagName.split(':')].pop() : null;
          });

        if (characterNames.length != 1) {
            metadata.push({ property: 'og:title', content: `Photo by ${photographers[0]}`});
            twitter.push({ name: 'twitter:title', content: `Photo by ${photographers[0]}` });
        } else {
            metadata.push({ property: 'og:title', content: `${capitalizeFirstLetter(characterNames[0])} (📸 ${photographers[0]})`})
            twitter.push({ name: 'twitter:title', content: `${capitalizeFirstLetter(characterNames[0])} (📸 ${photographers[0]})`});
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
    } else if (url.includes('/user/') && !url.includes("album")) {
        // username is in the url directly /user/
        const username = url.split('/user/')[1].split('/')[0];
        let response = await fetch(`https://solar.furtrack.com/get/u/${username}`, fetchParameters)
        if (!response.ok) {
            return { status: 'error', message: 'No metadata found' };
        }
        const data = await response.json();
        console.log(`data is ${JSON.stringify(data)}`)

        // "photography" if url contains "photography", "fursuting" if contains "fursuiting"
        let descriptionPageName = url.includes('photography') ? 'photography' : url.includes('fursuiting') ? 'fursuiting' : url.includes('likes') ? 'favorites' : '';
        

        metadata.push(
            { property: "og:title", content: `${data.user.username}'s profile` },
            { property: "og:description", content: `Check out ${data.user.username}'s ${descriptionPageName} gallery on Furtrack` },
            { property: "og:site_name", content: "furtrack.com"},
            { property: "og:type", content: "website"},
            { property: "og:image", content: `https://orca.furtrack.com/icons/${data.user.userIcon}.jpg` }
        );
        twitter.push(
            { name: "twitter:card", content: `${data.user.username}'s profile` }, 
            { name: "twitter:description", content: `Check out ${data.user.username}'s ${descriptionPageName} gallery on Furtrack` }, 
            { name: "twitter:image", content: `https://orca.furtrack.com/icons/${data.user.userIcon}.jpg` },
            { name: "twitter:site", content: "@furtrack" }
        );
        result = { url: `https://furtrack.com${url}`, metadata, twitter };
    } else if (url.includes("album")) {
        const username = url.split('/user/')[1].split('/')[0];
        const albumId = url.split('-').pop();
        console.log("processing album")
        let userData = await fetch(`https://solar.furtrack.com/get/u/${username}`, fetchParameters)
        if (!userData.ok) {
            return { status: 'error', message: 'No metadata found' };
        }
        const user = await userData.json();


        let albumData = await fetch(`https://solar.furtrack.com/view/album/${username}/${albumId}`, fetchParameters)
        if (!albumData.ok) {
            return { status: 'error', message: 'No metadata found' };
        }

        const album = await albumData.json();

        metadata.push(
            { property: "og:title", content: `${user.user.username}'s ${album.album.albumTitle} album` },
            { property: "og:description", content: `Check out ${user.user.username}'s ${album.album.albumTitle} album on Furtrack` },
            { property: "og:site_name", content: "furtrack.com"},
            { property: "og:type", content: "website"},
            { property: "og:image", content: `https://orca.furtrack.com/icons/${user.user.userIcon}.jpg` }
        );
        twitter.push(
            { name: "twitter:card", content: `${user.user.username}'s ${album.album.albumTitle} album`  }, 
            { name: "twitter:description", content: `Check out ${user.user.username}'s ${album.album.albumTitle} album on Furtrack` }, 
            { name: "twitter:image", content: `https://orca.furtrack.com/icons/${user.user.userIcon}.jpg` },
            { name: "twitter:site", content: "@furtrack" }
        );
        result = { url: `https://furtrack.com${url}`, metadata, twitter };
    }
        

    if (!result) {
        return { status: 'error', message: 'No metadata found' };
    }
    // Cache result in Redis for 24 hours
    await redisClient.setex(url, 86400, JSON.stringify(result));
    
    console.log('Metadata cached');
    return result;
});
