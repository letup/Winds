import axios from 'axios';
import joi from 'joi';

import db from '../utils/db';

import RSS from '../models/rss';
import Article from '../models/article';
import logger from '../utils/logger';
import { ProcessStreamQueue } from '../asyncTasks';
import { timeIt } from '../utils/statsd';
import { getStreamClient } from '../utils/stream';
import { sendFeedToCollections } from '../utils/collections';
import { setupAxiosRedirectInterceptor } from '../utils/axios';

if (require.main === module) {
	setupAxiosRedirectInterceptor(axios);
}

// connect the handler to the queue
logger.info('Starting the Stream worker');

ProcessStreamQueue(1, streamProcessor);

export async function streamProcessor(job) {
	logger.info(`Processing Stream feeds for feed ${job.data.rss}`);
	// just intercept error handling before it goes to Bull
	try {
		await handleStream(job);
	} catch (err) {
		const tags = { queue: 'stream' };
		const extra = { JobRSS: job.data.rss, JobArticles: job.data.articles };
		logger.error('Stream feed job ecountered an error', { err, tags, extra });
	}
	logger.info(`Completed processing Stream feeds for feed ${job.data.rss}`);
}

const joiObjectId = joi.alternatives().try(
	joi.string().length(12),
	joi.string().length(24).regex(/^[0-9a-fA-F]{24}$/)
);

const schema = joi.object().keys({
	rss: joiObjectId.required(),
	articles: joi.array().min(1).required(),
});
const itemSchema = joi.object().keys({
	id: joiObjectId.required(),
	publicationDate: joi.date().iso().required(),
});

export async function handleStream(job) {
	const validation = joi.validate(job.data, schema);
	if (!!validation.error) {
		logger.warn(`Stream job validation failed: ${validation.error.message}`);
		return;
	}

	const rssFeed = getStreamClient().feed('rss', job.data.rss);
	logger.debug(`Syncing ${job.data.articles.length} articles to Stream`);
	const articles = job.data.articles.filter(a => !joi.validate(a, itemSchema).error);
	if (!articles.length) {
		logger.warn(`No article passed validation: ${job.data.articles.map(a => joi.validate(a, itemSchema).error)}`);
		return;
	}

	if (articles.length > 0) {
		const rss = await RSS.findById(job.data.rss);
		await timeIt('winds.handle_stream.send_to_collections', () => sendFeedToCollections('rss', rss));
	}
}
