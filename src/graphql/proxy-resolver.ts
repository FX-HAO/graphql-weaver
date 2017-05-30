import {
    ASTNode, FragmentDefinitionNode, FragmentSpreadNode, GraphQLFieldResolver, GraphQLResolveInfo, InlineFragmentNode,
    print, SelectionSetNode, visit
} from 'graphql';
import { query } from './client';
import { OperationTypeNode } from '@types/graphql/language';

interface ResolverConfig {
    url: string;
    operation: OperationTypeNode;
    typeRenamer?: (name: string) => string;
}

export function createResolver(config: ResolverConfig): GraphQLFieldResolver<any, any> {
    return async function(source: any,
                    args: { [argName: string]: any },
                    context: any,
                    info: GraphQLResolveInfo): Promise<any> {

        const fragments = collectUsedFragments(info.fieldNodes, info.fragments);
        if (config.typeRenamer) {
            [...info.fieldNodes, ...fragments].forEach(node => renameTypes(node, config.typeRenamer!));
        }
        info.fieldNodes.forEach(node => fetchTypenameIfFragmentsPresent(node));
        const selections = info.fieldNodes
            .map(node => node.selectionSet ? node.selectionSet.selections : [])
            .reduce((a, b) => a.concat(b), []);
        const selectionStr = selections.map(print).join('\n');
        const fragmentsStr = fragments.map(print).join('\n');
        const queryStr = `${fragmentsStr}\n${config.operation} {\n${selectionStr}\n}`;
        console.log(queryStr);

        return await query(config.url, queryStr);
    };
}

function pick<TValue>(object: {[key: string]: TValue}, keys: string[]): TValue[] {
    return keys.map(key => object[key]);
}

function renameTypes(root: ASTNode, typeNameTransformer: (name: string) => string) {
    visit(root, {
        FragmentDefinition(node: FragmentDefinitionNode) {
            node.typeCondition.name.value = typeNameTransformer(node.typeCondition.name.value);
        },
        InlineFragment(node: InlineFragmentNode) {
            if (node.typeCondition) {
                node.typeCondition.name.value = typeNameTransformer(node.typeCondition.name.value);
            }
        }
    })
}

function fetchTypenameIfFragmentsPresent(root: ASTNode) {
    // The default implementation of resolveType of an interface looks at __typename.
    // Thus, it is simplest to just request that field whenever there is a fragment
    // This will cause a collision if the user requests a different field under __typename alias
    // This also means that the result always includes __typename if fragments are used, even when not requested
    visit(root, {
        SelectionSet(node: SelectionSetNode) {
            const requiresTypename = node.selections.some(sel => sel.kind == 'FragmentSpread' || sel.kind == 'InlineFragment');
            const requestsTypename = node.selections.some(sel => sel.kind == 'Field' && sel.name.value == '__typename');
            const isTypenameAilased = node.selections.some(sel => sel.kind == 'Field' && sel.name.value != '__typename' && !!sel.alias && sel.alias.value == '__typename');
            if (isTypenameAilased) {
                throw new Error(`Fields must not be aliased to __typename because this is a reserved field.`);
            }
            if (requiresTypename && !requestsTypename) {
                node.selections.push({
                    kind: 'Field',
                    name: {
                        kind: 'Name',
                        value: '__typename'
                    }
                });
            }
        }
    })
}

function collectUsedFragmentNames(roots: ASTNode[]): string[] {
    const fragments = new Set<string>();
    for (const root of roots) {
        visit(root, {
            FragmentSpread(node: FragmentSpreadNode) {
                fragments.add(node.name.value);
            }
        });
    }
    return Array.from(fragments);
}


function collectUsedFragments(roots: ASTNode[], fragments: {[name: string]: FragmentDefinitionNode}) {
    return pick(fragments, collectUsedFragmentNames(roots));
}
