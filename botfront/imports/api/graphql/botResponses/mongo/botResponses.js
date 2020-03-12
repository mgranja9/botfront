import { safeDump } from 'js-yaml/lib/js-yaml';
import shortid from 'shortid';
import { safeLoad } from 'js-yaml';
import BotResponses from '../botResponses.model';
import { clearTypenameField } from '../../../../lib/utils';
import { Stories } from '../../../story/stories.collection';
import { addTemplateLanguage } from '../../../../lib/botResponse.utils';
import { parsePayload } from '../../../../lib/storyMd.utils';

const indexResponseContent = ({ text = '', custom = null, buttons = [] }) => {
    const responseContent = [];
    if (text.length > 0) responseContent.push(text.replace(/\n/, ' '));
    if (custom) responseContent.push(safeDump(custom).replace(/\n/, ' '));
    buttons.forEach(({ title = '', payload = '', url = '' }) => {
        if (title.length > 0) responseContent.push(title);
        if (payload.length > 0 && payload[0] === '/') {
            const { intent, entities } = parsePayload(payload);
            responseContent.push(intent);
            entities.forEach(entity => responseContent.push(entity));
        }
        if (url.length > 0) responseContent.push(url);
    });
    return responseContent;
};

export const indexBotResponse = (response) => {
    let responseContent = [];
    responseContent.push(response.key);
    response.values.forEach((value) => {
        value.sequence.forEach((sequence) => {
            responseContent = [...responseContent, ...indexResponseContent(safeLoad(sequence.content))];
        });
    });
    return responseContent.join('\n');
};

const mergeAndIndexBotResponse = async ({
    projectId, language, key, newPayload, index,
}) => {
    const botResponse = await BotResponses.findOne({ projectId, key }).lean();
    if (!botResponse) {
        console.log('no bot response, creating index');
        console.log(newPayload);
        const textIndex = [key, ...indexResponseContent(newPayload)].join('\n');
        return textIndex;
    }
    const valueIndex = botResponse.values.findIndex(({ lang }) => lang === language);
    botResponse.values[valueIndex].sequence[index] = { content: safeDump(clearTypenameField(newPayload)) };
    return indexBotResponse(botResponse);
};

export const createResponses = async (projectId, responses) => {
    const newResponses = typeof responses === 'string' ? JSON.parse(responses) : responses;
    // eslint-disable-next-line array-callback-return
    const answer = newResponses.map((newResponse) => {
        const properResponse = newResponse;
        properResponse.projectId = projectId;
        properResponse.textIndex = indexBotResponse(newResponse);
        return BotResponses.update({ projectId, key: newResponse.key }, properResponse, { upsert: true });
    });

    return Promise.all(answer);
};

export const updateResponse = async (projectId, _id, newResponse) => {
    const textIndex = indexBotResponse(newResponse);
    const result = BotResponses.updateOne(
        { projectId, _id },
        { ...newResponse, textIndex },
        { runValidators: true },
    ).exec();
    return result;
};


export const createResponse = async (projectId, newResponse) => {
    const textIndex = indexBotResponse(newResponse);
    return BotResponses.create({
        ...clearTypenameField(newResponse),
        projectId,
        textIndex,
    });
};

export const createAndOverwriteResponses = async (projectId, responses) => Promise.all(
    responses.map(({ key, _id, ...rest }) => {
        const textIndex = indexBotResponse({ key, _id, ...rest });
        return BotResponses.findOneAndUpdate(
            { projectId, key }, {
                projectId, key, ...rest, textIndex,
            }, { new: true, lean: true, upsert: true },
        );
    }),
);

export const getBotResponses = async projectId => BotResponses.find({
    projectId,
}).lean();

export const deleteResponse = async (projectId, key) => BotResponses.findOneAndDelete({ projectId, key });

export const getBotResponse = async (projectId, key) => BotResponses.findOne({
    projectId,
    key,
}).lean();

export const getBotResponseById = async (_id) => {
    const botResponse = await BotResponses.findOne({
        _id,
    }).lean();
    return botResponse;
};


export const upsertResponse = async ({
    projectId, language, key, newPayload, index,
}) => {
    console.log(newPayload);
    const textIndex = await mergeAndIndexBotResponse({
        projectId, language, key, newPayload, index,
    });
    const update = index === -1
        ? { $push: { 'values.$.sequence': { $each: [{ content: safeDump(clearTypenameField(newPayload)) }] } }, $set: { textIndex } }
        : { $set: { [`values.$.sequence.${index}`]: { content: safeDump(clearTypenameField(newPayload)) }, textIndex } };
    return BotResponses.findOneAndUpdate(
        { projectId, key, 'values.lang': language },
        update,
        { new: true, lean: true },
    ).exec().then(result => (
        result
    || BotResponses.findOneAndUpdate(
        { projectId, key },
        {
            $push: { values: { lang: language, sequence: [{ content: safeDump(clearTypenameField(newPayload)) }] } },
            $setOnInsert: {
                _id: shortid.generate(),
                projectId,
                key,
                textIndex,
            },
        },
        { new: true, lean: true, upsert: true },
    )
    ));
};

export const deleteVariation = async ({
    projectId, language, key, index,
}) => {
    const responseMatch = await BotResponses.findOne(
        { projectId, key, 'values.lang': language },
    ).exec();
    const sequenceIndex = responseMatch && responseMatch.values.findIndex(({ lang }) => lang === language);

    const { sequence } = responseMatch.values[sequenceIndex];
    if (!sequence) return null;
    const updatedSequence = [...sequence.slice(0, index), ...sequence.slice(index + 1)];
    responseMatch.values[sequenceIndex].sequence = updatedSequence;
    const textIndex = indexBotResponse(responseMatch);
    return BotResponses.findOneAndUpdate(
        { projectId, key, 'values.lang': language },
        { $set: { 'values.$.sequence': updatedSequence, textIndex } },
        { new: true, lean: true },
    );
};

export const newGetBotResponses = async ({
    projectId, template, language, options = {},
}) => {
    const { emptyAsDefault } = options;
    // template (optional): str || array
    // language (optional): str || array
    let templateKey = {}; let languageKey = {}; let languageFilter = [];
    if (template) {
        const templateArray = typeof template === 'string' ? [template] : template;
        templateKey = { key: { $in: templateArray } };
    }
    if (language) {
        const languageArray = typeof language === 'string' ? [language] : language;
        languageKey = { 'values.lang': { $in: languageArray } };
        languageFilter = [{
            $addFields: { values: { $filter: { input: '$values', as: 'value', cond: { $in: ['$$value.lang', languageArray] } } } },
        }];
    }
    const aggregationParameters = [

        { $unwind: '$values' },
        { $unwind: '$values.sequence' },
        {
            $project: {
                _id: false,
                key: '$key',
                language: '$values.lang',
                channel: '$values.channel',
                payload: '$values.sequence.content',
                metadata: '$metadata',
            },
        },
    ];

    let templates = await BotResponses.aggregate([
        { $match: { projectId, ...templateKey, ...languageKey } },
        ...languageFilter,
        ...aggregationParameters,
    ]).allowDiskUse(true);

    if ((!templates || !templates.length > 0) && emptyAsDefault) {
        /* replace empty response content with default content
           of the correct response type
        */
        templates = await BotResponses.aggregate([
            { $match: { projectId, ...templateKey } },
            ...aggregationParameters,
        ]).allowDiskUse(true);
        templates = addTemplateLanguage(templates, language);
    }
    return templates;
};


export const deleteResponsesRemovedFromStories = (removedResponses, projectId) => {
    const sharedResponses = Stories.find({ events: { $in: removedResponses } }, { fields: { events: true } }).fetch();
    if (removedResponses && removedResponses.length > 0) {
        const deleteResponses = removedResponses.filter((event) => {
            if (!sharedResponses) return true;
            return !sharedResponses.find(({ events }) => events.includes(event));
        });
        deleteResponses.forEach(event => deleteResponse(projectId, event));
    }
};
