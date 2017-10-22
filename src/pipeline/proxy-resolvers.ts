import { PipelineModule } from './pipeline-module';
import { FieldTransformationContext, GraphQLNamedFieldConfig, SchemaTransformer } from 'graphql-transformer';
import { ExecutionResult, GraphQLError, GraphQLLeafType, GraphQLResolveInfo, print, ResponsePath } from 'graphql';
import { getFieldAsQueryParts, getQueryFromParts } from '../graphql/field-as-query';
import { GraphQLClient } from '../graphql-client/graphql-client';
import { Query } from '../graphql/common';
import { EndpointConfig } from '../config/weaving-config';
import { cloneSelectionChain, collectFieldNodesInPath } from '../graphql/language-utils';
import { isRootType } from '../graphql/schema-utils';
import { collectAliasesInResponsePath } from '../graphql/resolver-utils';
import { assertSuccessfulResult } from '../graphql/execution-result';
import { moveErrorsToData } from '../graphql/errors-in-result';
import { isArray } from 'util';

export interface Config {
    readonly client: GraphQLClient
    processQuery(query: Query): Query
    readonly endpointConfig: EndpointConfig
}

/**
 * Adds resolvers to the top-level fields of all root types that proxy the request to a specified endpoint
 */
export class ProxyResolversModule implements PipelineModule {
    constructor(private readonly config: Config) {

    }

    getSchemaTransformer() {
        return new ResolverTransformer(this.config)
    }
}

export class ResolverTransformer implements SchemaTransformer {
    constructor(private readonly config: Config) {

    }

    transformField(config: GraphQLNamedFieldConfig<any, any>, context: FieldTransformationContext): GraphQLNamedFieldConfig<any, any> {
        if (!isRootType(context.oldOuterType, context.oldSchema)) {
            return config;
        }

        return {
            ...config,
            resolve: async (source, args, context, info: GraphQLResolveInfo) => {
                const {selectionSet, ...parts} = getFieldAsQueryParts(info);

                // wrap selection into the field hierarchy from root to the field being resolved
                const aliases = collectAliasesInResponsePath(info.path);
                const fieldNodes = collectFieldNodesInPath(info.operation.selectionSet, aliases, info.fragments);
                // if the selection set is empty, this field node is of sclar type and does not have selections
                const newSelectionSet = cloneSelectionChain(fieldNodes, selectionSet.selections.length ? selectionSet : undefined);
                let query = getQueryFromParts({...parts, selectionSet: newSelectionSet});

                query = this.config.processQuery(query);

                let result = await this.config.client.execute(query.document, query.variableValues, context);
                result = moveErrorsToData(result, e => prefixGraphQLErrorPath(e, info.path, 1));
                const data = assertSuccessfulResult(result); // find and throw global errors
                const propertyOnResult = aliases[aliases.length - 1];
                if (typeof data != 'object' || !(propertyOnResult in data)) {
                    throw new Error(`Expected GraphQL endpoint to return object with property ${JSON.stringify(propertyOnResult)}`)
                }
                return data[propertyOnResult];
            }
        };
    }
}

function prefixGraphQLErrorPath(error: GraphQLError, pathPrefix: ResponsePath, removePrefixLength: number) {
    if (!(error instanceof GraphQLError) || !error.path) {
        return error;
    }
    const newPath = [
        ...responsePathToArray(pathPrefix),
        ...error.path.slice(removePrefixLength)
    ];
    return new GraphQLError(error.message, error.nodes, error.source, error.positions, newPath, error.originalError)
}

function responsePathToArray(path: ResponsePath): (string|number)[] {
    if (!path) {
        return [];
    }
    return [
        ...responsePathToArray(path.prev),
        path.key
    ];
}