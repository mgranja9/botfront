import { mergeTypes } from 'merge-graphql-schemas';
import conversationsResolver from './conversations/resolvers/conversationsResolver';
import conversationTypes from './conversations/schemas';
import activityResolver from './activity/resolvers/activityResolver';
import activityTypes from './activity/schemas';
import commonResolver from './common/commonResolver';
import commonTypes from './common/common.types.graphql';
import botResponsesResolvers from './botResponses/resolvers';
import botResponsesTypes from './botResponses/schemas';
import configResolver from './config/configResolver';
import configTypes from './config/config.types.graphql';
import nluResolvers from './nlu/resolvers';
import nluTypes from './nlu/schemas';
import trackerStoreResolver from './trackerStore/resolvers/trackerStoreResolver';
import trackerStoreTypes from './trackerStore/schemas';


export const resolvers = [
    conversationsResolver,
    ...botResponsesResolvers,
    ...nluResolvers,
    activityResolver,
    commonResolver,
    configResolver,
    trackerStoreResolver,
];

export const typeDefs = mergeTypes([
    ...conversationTypes,
    ...botResponsesTypes,
    ...activityTypes,
    ...nluTypes,
    ...trackerStoreTypes,
    commonTypes,
    configTypes,
], { all: true });

export const schemaDirectives = {
};
