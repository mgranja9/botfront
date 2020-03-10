import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import uuidv4 from 'uuid/v4';
import { traverseStory, aggregateEvents } from '../../lib/story.utils';
import { indexStory } from './stories.index';

import { Stories } from './stories.collection';
import { Projects } from '../project/project.collection';
import { NLUModels } from '../nlu_model/nlu_model.collection';
import { deleteResponsesRemovedFromStories } from '../graphql/botResponses/mongo/botResponses';

export const checkStoryNotEmpty = story => story.story && !!story.story.replace(/\s/g, '').length;

Meteor.methods({
    'stories.insert'(story) {
        check(story, Match.OneOf(Object, [Object]));
        if (Array.isArray(story)) {
            return Stories.rawCollection().insertMany(story
                .map(s => ({
                    ...s,
                    ...(s._id ? {} : { _id: uuidv4() }),
                    events: aggregateEvents(s),
                })));
        }
        const { textIndex, events } = indexStory(story, { includeEventsField: true });
        console.log(textIndex);
        return Stories.insert({ ...story, events, textIndex });
    },

    async 'stories.update'(story, projectId, options = {}) {
        check(story, Object);
        check(projectId, String);
        check(options, Object);
        const { noClean } = options;
        const {
            _id, path, ...rest
        } = story;
        
        if (!path) {
            if (story.story || story.branches) {
                rest.textIndex = indexStory(story);
            } else if (story.title) {
                rest.textIndex.title = story.title;
            }
            return Stories.update({ _id }, { $set: { ...rest } });
        }
        const originStory = Stories.findOne({ _id });
        // passing story.story and path[(last index)] AKA storyBranchId to aggregate events allows it to aggregate events with the updated story md
        // const newEvents = aggregateEvents(originStory, { ...rest, _id: path[path.length - 1] }); // path[(last index)] is the id of the updated branch
        const { textIndex, events: newEvents } = indexStory(originStory, {
            update: { ...rest, _id: path[path.length - 1] },
            includeEventsField: true,
        });

        const { indices } = traverseStory(originStory, path);
        const update = indices.length
            ? Object.assign(
                {},
                ...Object.keys(rest).map(key => (
                    { [`branches.${indices.join('.branches.')}.${key}`]: rest[key] }
                )),
            )
            : rest;
        const result = await Stories.update({ _id }, { $set: { ...update, events: newEvents, textIndex } });

        if (!noClean) { // check if a response was removed
            const { events: oldEvents } = originStory || {};
            const removedEvents = (oldEvents || []).filter(event => event.match(/^utter_/) && !newEvents.includes(event));
            deleteResponsesRemovedFromStories(removedEvents, projectId);
        }
        return result;
    },

    async 'stories.delete'(story, projectId) {
        check(story, Object);
        check(projectId, String);
        const result = await Stories.remove(story);
        deleteResponsesRemovedFromStories(story.events, projectId);
        return result;
    },

    'stories.addCheckpoints'(destinationStory, branchPath) {
        check(destinationStory, String);
        check(branchPath, Array);
        return Stories.update(
            { _id: destinationStory },
            { $addToSet: { checkpoints: branchPath } },
        );
    },
    'stories.removeCheckpoints'(destinationStory, branchPath) {
        check(destinationStory, String);
        check(branchPath, Array);
        return Stories.update(
            { _id: destinationStory },
            { $pullAll: { checkpoints: [branchPath] } },
        );
    },
    'stories.search'(projectId, language, search) {
        check(projectId, String);
        check(language, String);
        check(search, String);
        const project = Projects.findOne({ _id: projectId }, { fields: { nlu_models: 1 } });
        const nluModels = project.nlu_models;
        const searchRegex = new RegExp(search);
        const model = NLUModels.findOne(
            { _id: { $in: nluModels }, language },
        );
        const modelExamples = model.training_data.common_examples;
        const intents = modelExamples.reduce((filtered, option) => {
            if (searchRegex.test(option.text)) {
                return [...filtered, option.intent];
            }
            return filtered;
        }, []);
        const matched = Stories.find(
            { projectId, $text: { $search: `${search} ${intents.join(' ')}` } },
            { fields: { _id: 1, title: 1 } },
        ).fetch();
        return matched;
    },
});
