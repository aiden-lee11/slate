import { INodeData, TNode } from './types';

/**
 * Agent -> Builder handoff.
 *
 * An agent can hand a user a create-only graph by encoding the same
 * `Record<resourceId, resource>` map it would POST to /api/v2/graphs/plan and
 * putting it in the URL *fragment* (the part after '#'), e.g.
 *
 *     /builder#graph=<base64url(gzip(JSON))>
 *
 * The fragment is never sent to the server, proxies, or logs and is not
 * included in the Referer header, so the graph stays client-side only. The
 * Builder decodes it and hydrates the workspace by reusing the same node-
 * injection path recipes use (see nodesFromResourceMap / addNodesToWorkspace).
 */
export type ResourceMap = Record<string, INodeData>;

const GRAPH_FRAGMENT_RE = /[#&]graph=([^&]+)/;

// gzip streams start with the magic bytes 0x1f 0x8b.
const isGzip = (bytes: Uint8Array): boolean =>
    bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

// base64url string -> raw bytes
const base64urlToBytes = (value: string): Uint8Array => {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};

// Accepts both gzipped and plain (uncompressed) payloads so links stay
// human-decodable in dev while real handoffs can compress. DecompressionStream
// is reached via globalThis so this compiles even on TS lib versions whose
// dom typings predate it; it is guarded for runtimes that lack the API.
const bytesToText = async (bytes: Uint8Array): Promise<string> => {
    const globalObj = globalThis as any;
    if (isGzip(bytes) && typeof globalObj.DecompressionStream !== 'undefined') {
        const stream = new Response(bytes).body!.pipeThrough(new globalObj.DecompressionStream('gzip'));
        return new Response(stream as any).text();
    }
    return new TextDecoder().decode(bytes);
};

/**
 * Decode a `#graph=<encoded>` fragment into a resource map. Returns null when
 * the fragment is absent, empty, or malformed (never throws).
 */
export const decodeGraphFragment = async (hash: string): Promise<ResourceMap | null> => {
    const match = GRAPH_FRAGMENT_RE.exec(hash);
    if (!match) {
        return null;
    }
    try {
        const bytes = base64urlToBytes(match[1]);
        const json = await bytesToText(bytes);
        const map = JSON.parse(json) as ResourceMap;
        if (map && typeof map === 'object' && Object.keys(map).length > 0) {
            return map;
        }
        return null;
    } catch (error) {
        console.error('Failed to decode graph handoff fragment', error);
        return null;
    }
};

/**
 * Turn a resource map into React Flow nodes. Mirrors the recipe load transform
 * (RecipeModal.handleAddToWorkspace) so both share one code path.
 */
export const nodesFromResourceMap = (map: ResourceMap): TNode[] =>
    Object.values(map).map((resource) => ({
        position: { x: 0, y: 0 }, // will auto layout
        type: resource.resourceDefinitionClass,
        data: resource,
        id: resource.id,
    }));
