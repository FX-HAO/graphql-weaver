import {
    ArgumentNode, DocumentNode, execute, FieldNode, FragmentDefinitionNode, getNamedType, GraphQLError, GraphQLField,
    GraphQLInputObjectType, GraphQLInputType, GraphQLList, GraphQLNamedType, GraphQLNonNull, GraphQLOutputType,
    GraphQLScalarType, GraphQLSchema, OperationDefinitionNode, ResponsePath, SelectionSetNode, VariableDefinitionNode
} from 'graphql';
import { getNonNullType, walkFields } from '../../graphql/schema-utils';
import { LinkConfig } from '../../extended-schema/extended-schema';
import { arrayToObject, intersect, modifyPropertyAtPath, throwError } from '../../utils/utils';
import { getFieldAsQueryParts, SlimGraphQLResolveInfo } from '../../graphql/field-as-query';
import {
    addFieldSelectionSafely, addVariableDefinitionSafely, createFieldNode, createNestedArgumentWithVariableNode,
    createSelectionChain
} from '../../graphql/language-utils';
import { isArray } from 'util';
import { assertSuccessfulResult } from '../../graphql/execution-result';
import { FieldErrorValue, moveErrorsToData } from '../../graphql/errors-in-result';
import { prefixGraphQLErrorPath } from './error-paths';
import { WeavingError, WeavingErrorConsumer } from '../../config/errors';

export const FILTER_ARG = 'filter';
export const ORDER_BY_ARG = 'orderBy';
export const FIRST_ARG = 'first';
export const SKIP_ARG = 'skip';

export function parseLinkTargetPath(path: string, schema: GraphQLSchema): { field: GraphQLField<any, any>, fieldPath: string[] } | undefined {
    const fieldPath = path.split('.');
    const queryType = schema.getQueryType();
    if (!queryType) {
        return undefined;
    }
    const field = walkFields(queryType, fieldPath);
    if (!field) {
        return undefined;
    }
    return {field, fieldPath};
}

async function basicResolve(params: {
    targetFieldPath: ReadonlyArray<string>,
    payloadSelectionSet: SelectionSetNode,
    args?: ArgumentNode[],
    variableDefinitions: VariableDefinitionNode[],
    variableValues: { [name: string]: any },
    fragments: ReadonlyArray<FragmentDefinitionNode>,
    context: any,
    schema: GraphQLSchema,
    path: ResponsePath
}) {
    const {payloadSelectionSet, variableValues, variableDefinitions, context, schema, targetFieldPath, args, fragments} = params;

    // wrap selection in field node chain on target, and add the argument with the key field
    const outerFieldNames = [...targetFieldPath];
    const innerFieldName = outerFieldNames.pop()!; // this removes the last element of outerFields in-place
    const innerFieldNode: FieldNode = {
        ...createFieldNode(innerFieldName),
        selectionSet: payloadSelectionSet,
        arguments: args
    };
    const innerSelectionSet: SelectionSetNode = {
        kind: 'SelectionSet',
        selections: [innerFieldNode]
    };
    const selectionSet = createSelectionChain(outerFieldNames, innerSelectionSet);

    // create document
    const operation: OperationDefinitionNode = {
        kind: 'OperationDefinition',
        operation: 'query',
        variableDefinitions,
        selectionSet
    };
    const document: DocumentNode = {
        kind: 'Document',
        definitions: [
            operation,
            ...fragments
        ]
    };

    // execute
    // note: don't need to run query pipeline on this document because it will be passed to the unlinked schema
    // which will in turn peform their query pipeline (starting from the next module onwards) on the query in the
    // proxy resolver. Query pipeline modules before this module have already been exectued on the whole query
    // (because the linked fields obviously have not been truncated there)
    // TODO invesitage nested links, might be necessary to execute this particiular query pipeline module
    const result = await execute(schema, document, {} /* root */, context, variableValues);

    const resultData = assertSuccessfulResult(moveErrorsToData(result, e => prefixGraphQLErrorPath(e, params.path, targetFieldPath.length)));

    // unwrap
    return targetFieldPath.reduce((data, fieldName) => {
        if (!(fieldName in data)) {
            throw new Error(`Property "${fieldName}" missing in result of "${targetFieldPath.join('.')}"`);
        }
        const result = data![fieldName];
        if (result instanceof FieldErrorValue) {
            const err = result.getError();
            const message = `Field "${targetFieldPath.join('.')}" reported error: ${err.message}`;

            if (err instanceof GraphQLError) {
                // see if we got some useful location information to keep
                // but don't do this if we don't have location info, because graphql 0.13 won't add the location info of the path if it's a GraphQLError
                const hasLocationInfo =
                    (err.positions && err.positions.length) ||
                    (err.nodes && err.nodes.some(node => !!node.loc));
                if (hasLocationInfo) {
                    throw new GraphQLError(message, err.nodes, err.source, err.positions, err.path, err);
                }
            }

            throw new Error(message);
        }
        return result;
    }, resultData);
}

/**
 * Fetches a list of objects by their keys
 *
 * @param params.keys an array of key values
 * @param params.info the resolve info that specifies the structure of the query
 * @return an array of objects, with 1:1 mapping to the keys
 */
export async function fetchLinkedObjects(params: {
    keys: any[],
    keyType: GraphQLScalarType,
    linkConfig: LinkConfig,
    unlinkedSchema: GraphQLSchema,
    context: any,
    info: SlimGraphQLResolveInfo
}): Promise<any[]> {
    const {unlinkedSchema, keys, keyType, linkConfig, info, context} = params;

    const {fieldPath: targetFieldPath} = parseLinkTargetPath(linkConfig.field, unlinkedSchema) ||
    throwError(`Link target field as ${linkConfig.field} which does not exist in the schema`);

    /**
     * Fetches one object, or a list of objects in batch mode, according to the query underlying the resolveInfo
     * @param key the key
     * @param resolveInfo the resolveInfo from the request
     * @param context graphql execution context
     * @returns {Promise<void>}
     */
    async function fetchSingular(key: any) {
        const {fragments, ...originalParts} = getFieldAsQueryParts(info);

        // add variable
        const varType = getNonNullType(keyType);
        const varNameBase = linkConfig.argument.split('.').pop()!;
        const {variableDefinitions, name: varName} = addVariableDefinitionSafely(originalParts.variableDefinitions, varNameBase, varType);
        const variableValues = {
            ...originalParts.variableValues,
            [varName]: key
        };

        return await basicResolve({
            targetFieldPath,
            schema: unlinkedSchema,
            context,
            variableDefinitions,
            variableValues,
            fragments,
            args: [
                createNestedArgumentWithVariableNode(linkConfig.argument, varName)
            ],
            payloadSelectionSet: originalParts.selectionSet,
            path: info.path
        });
    }

    /**
     * Fetches one object, or a list of objects in batch mode, according to the query underlying the resolveInfo
     * @param keyOrKeys either a single key of a list of keys, depending on link.batchMode
     * @param resolveInfo the resolveInfo from the request
     * @param context graphql execution context
     * @returns {Promise<void>}
     */
    async function fetchBatchOneToOne(keys: any) {
        const {fragments, ...originalParts} = getFieldAsQueryParts(info);

        // add variable
        const varType = new GraphQLNonNull(new GraphQLList(getNonNullType(keyType)));
        const varNameBase = linkConfig.argument.split('.').pop()!;
        const {variableDefinitions, name: varName} = addVariableDefinitionSafely(originalParts.variableDefinitions, varNameBase, varType);
        const variableValues = {
            ...originalParts.variableValues,
            [varName]: keys
        };

        return basicResolve({
            targetFieldPath,
            schema: unlinkedSchema,
            context,
            variableDefinitions,
            variableValues,
            fragments,
            args: [
                createNestedArgumentWithVariableNode(linkConfig.argument, varName)
            ],
            payloadSelectionSet: originalParts.selectionSet,
            path: info.path
        });
    }


    /**
     * Fetches one object, or a list of objects in batch mode, according to the query underlying the resolveInfo
     * @param keyOrKeys either a single key of a list of keys, depending on link.batchMode
     * @param resolveInfo the resolveInfo from the request
     * @param context graphql execution context
     * @returns {Promise<void>}
     */
    async function fetchBatchWithKeyField(keyOrKeys: any) {
        const {fragments, ...originalParts} = getFieldAsQueryParts(info);

        // add variable
        const varType = new GraphQLNonNull(new GraphQLList(getNonNullType(keyType)));
        const varNameBase = linkConfig.argument.split('.').pop()!;
        const {variableDefinitions, name: varName} = addVariableDefinitionSafely(originalParts.variableDefinitions, varNameBase, varType);
        const variableValues = {
            ...originalParts.variableValues,
            [varName]: keyOrKeys
        };

        // add keyField
        const {alias: keyFieldAlias, selectionSet: payloadSelectionSet} =
            addFieldSelectionSafely(originalParts.selectionSet, linkConfig.keyField!, arrayToObject(fragments, f => f.name.value));

        const data = await basicResolve({
            targetFieldPath,
            schema: unlinkedSchema,
            context,
            variableDefinitions,
            variableValues,
            fragments,
            args: [
                createNestedArgumentWithVariableNode(linkConfig.argument, varName)
            ],
            payloadSelectionSet,
            path: info.path
        });

        checkObjectsAndKeysForErrorValues(data, keyFieldAlias, linkConfig.keyField!);

        // unordered case: endpoints does not preserve order, so we need to remap based on a key field
        // first, create a lookup table from id to item
        if (!isArray(data)) {
            throw new Error(`Result of ${targetFieldPath.join('.')} expected to be an array because batchMode is true`);
        }
        const map = new Map((<any[]>data).map(item => <[any, any]>[item[keyFieldAlias], item]));
        // Then, use the lookup table to efficiently order the result
        return (keyOrKeys as any[]).map(key => map.get(key));
    }

    if (!linkConfig.batchMode) {
        return keys.map(key => fetchSingular(key));
    }

    if (linkConfig.keyField) {
        return fetchBatchWithKeyField(keys);
    }
    return fetchBatchOneToOne(keys);
}

export async function fetchJoinedObjects(params: {
    keys: any[],
    additionalFilter: any,
    orderBy?: string,
    first?: number,
    skip?: number,
    filterType: GraphQLInputType,
    keyType: GraphQLScalarType,
    linkConfig: LinkConfig,
    unlinkedSchema: GraphQLSchema,
    context: any,
    info: SlimGraphQLResolveInfo
}): Promise<{ orderedObjects: {[key:string]:any}[], objectsByID: Map<string, {[key:string]:any}>, keyFieldAlias: string }> {
    const {unlinkedSchema, additionalFilter, orderBy, filterType, linkConfig, info, context, keys} = params;
    const {fragments, ...originalParts} = getFieldAsQueryParts(info);

    const {fieldPath: targetFieldPath} = parseLinkTargetPath(linkConfig.field, unlinkedSchema) ||
    throwError(() => new WeavingError(`Target field ${JSON.stringify(linkConfig.field)} does not exist`));

    const [filterArgumentName, ...keyFieldPath] = linkConfig.argument.split('.');
    if (!keyFieldPath) {
        throw new WeavingError(`argument ${JSON.stringify(linkConfig.argument)} on link field needs to be a path of the form argumentName.fieldPath, where fieldPath is dot-separated.`);
    }

    const filterValue = modifyPropertyAtPath(additionalFilter, existingKeys => existingKeys ? intersect(existingKeys, keys) : keys, keyFieldPath);

    // add variable
    const varNameBase = info.fieldNodes[0].name.value + 'Filter';
    const {variableDefinitions, name: varName} = addVariableDefinitionSafely(originalParts.variableDefinitions, varNameBase, filterType);
    const variableValues = {
        ...originalParts.variableValues,
        [varName]: filterValue
    };

    // add keyField
    const {alias: keyFieldAlias, selectionSet: payloadSelectionSet} =
        addFieldSelectionSafely(originalParts.selectionSet, linkConfig.keyField!, arrayToObject(fragments, f => f.name.value));

    const filterArgument: ArgumentNode = {
        kind: 'Argument',
        name: {
            kind: 'Name',
            value: filterArgumentName
        },
        value: {
            kind: 'Variable',
            name: {
                kind: 'Name',
                value: varName
            }
        }
    };

    let args = [filterArgument];

    if (orderBy) {
        const orderByArg: ArgumentNode = {
            kind: 'Argument',
            name: {
                kind: 'Name',
                value: ORDER_BY_ARG
            },
            value: {
                kind: 'EnumValue',
                value: orderBy
            }
        };
        args = [...args, orderByArg];
    }

    if (params.first != undefined) {
        const firstArg: ArgumentNode = {
            kind: 'Argument',
            name: {
                kind: 'Name',
                value: FIRST_ARG
            },
            value: {
                kind: 'IntValue',
                value: params.first + ""
            }
        };
        args = [...args, firstArg];
    }

    if (params.skip) {
        const skipArg: ArgumentNode = {
            kind: 'Argument',
            name: {
                kind: 'Name',
                value: SKIP_ARG
            },
            value: {
                kind: 'IntValue',
                value: params.skip + ""
            }
        };
        args = [...args, skipArg];
    }

    const data = await basicResolve({
        targetFieldPath,
        schema: unlinkedSchema,
        context,
        variableDefinitions,
        variableValues,
        fragments,
        args,
        payloadSelectionSet,
        path: info.path
    });

    if (!isArray(data)) {
        throw new Error(`Result of ${targetFieldPath.join('.')} expected to be an array because batchMode is true`);
    }

    checkObjectsAndKeysForErrorValues(data, keyFieldAlias, linkConfig.keyField!);

    const objectsByID = new Map((<any[]>data).map(item => <[any, any]>[item[keyFieldAlias], item]));

    return {
        orderedObjects: data,
        objectsByID,
        keyFieldAlias
    };
}

export function getLinkArgumentType(linkConfig: LinkConfig, targetField: GraphQLField<any, any>): GraphQLInputType {
    const [filterArgumentName, ...keyFieldPath] = linkConfig.argument.split('.');
    const arg = targetField.args.filter(arg => arg.name == filterArgumentName)[0];
    if (!arg) {
        throw new WeavingError(`Argument ${JSON.stringify(filterArgumentName)} does not exist on target field ${JSON.stringify(linkConfig.field)}`);
    }
    const type = arg.type;
    return keyFieldPath.reduce((type, fieldName) => {
        if (!(type instanceof GraphQLInputObjectType) || !(fieldName in type.getFields())) {
            throw new Error(`Argument path ${JSON.stringify(linkConfig.argument)} cannot be resolved: ${type} does not have a field ${JSON.stringify(fieldName)}`);
        }
        return type.getFields()[fieldName].type
    }, type);
}

export function getKeyType(config: { linkConfig: LinkConfig, linkFieldType: GraphQLOutputType, linkFieldName: string, parentObjectType: GraphQLNamedType, targetField: GraphQLField<any, any>, reportError: WeavingErrorConsumer}) {
    const linkKeyType = getNamedType(config.linkFieldType);
    const argumentType = getNamedType(getLinkArgumentType(config.linkConfig, config.targetField));
    if (!(linkKeyType instanceof GraphQLScalarType)) {
        throw new WeavingError(`Type of @link field must be scalar type or list/non-null type of scalar type, but is ${config.linkFieldType}`);
    }
    if (!(argumentType instanceof GraphQLScalarType)) {
        throw new WeavingError(`Type of argument field ${JSON.stringify(config.linkConfig.argument)} must be scalar type or list/non-null-type of a scalar type, but is ${argumentType}`);
    }
    // comparing the names here. Can't use reference equality on the types because mapped and unmapped types are confused here.
    // We don't rename scalars in this module, so this is fine
    if (argumentType.name != linkKeyType.name) {
        config.reportError(new WeavingError(`Link field ${JSON.stringify(config.linkFieldName)} is of type ${linkKeyType}, but argument ${JSON.stringify(config.linkConfig.argument)} on target field ${JSON.stringify(config.linkConfig.field)} has type ${argumentType}`));
    }

    // Even if the types do not match, we can still continue and just pass the link value as argument. For ID/String/Int mismatches, this should not be a problem.
    // However, we need to use the argument type as variable name, so this will be returned
    return argumentType;
}

function checkObjectsAndKeysForErrorValues(objects: any, keyFieldAlias: string, keyFieldName: string) {
    // Don't try to access the key field on this error object - just throw it
    if (objects instanceof FieldErrorValue) {
        throw objects.getError();
    }
    const erroredKeys: FieldErrorValue[] = objects
        .map((item: any) => item[keyFieldAlias])
        .filter((keyValue: any) => keyValue instanceof FieldErrorValue);
    if (erroredKeys.length) {
        throw new Error(`Errors retrieving key field ${JSON.stringify(keyFieldName)}:\n\n${erroredKeys.map(error => error.getError().message).join('\n\n')}`);
    }
}
