import { INodeData, TNode } from './types';
import { NEW_NODE_ID_PREFIX } from './constants';

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
 *
 * The handoff is create-only, and that is *enforced* here (see
 * isCreateOnlyResource), not merely documented: the fragment is attacker-
 * controllable (a crafted link) and the decoded graph flows straight into the
 * workspace and then Plan/Execute. Every resource must be a brand-new node
 * (temporary id, the same convention isNewNode uses) and may not request an
 * update or deletion of an existing resource.
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
 * A handed-off resource must be a well-formed, create-only node:
 *  - a plain object keyed in the map by its own id,
 *  - a *temporary* id (NEW_NODE_ID_PREFIX) so the backend treats it as a create
 *    rather than an update/delete of an existing resource,
 *  - not a deletion (`deleted: true`),
 *  - carrying the fields we dereference to render a node and to Plan.
 * Anything else fails validation and causes the whole payload to be rejected,
 * so decodeGraphFragment returns null instead of letting a malformed or
 * destructive graph reach the workspace.
 */
const isCreateOnlyResource = (id: string, value: unknown): value is INodeData => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const r = value as Record<string, unknown>;
    // create-only: temporary id that matches its map key.
    if (typeof r.id !== 'string' || r.id !== id || !r.id.startsWith(NEW_NODE_ID_PREFIX)) {
        return false;
    }
    // reject destructive/update intent — a create-only graph never deletes.
    if (r.deleted === true) {
        return false;
    }
    // shape required to render a node (type) and to Plan (desiredState).
    if (typeof r.resourceDefinitionClass !== 'string') {
        return false;
    }
    if (!r.desiredState || typeof r.desiredState !== 'object') {
        return false;
    }
    return true;
};

/**
 * Whether a `#graph=` payload is present at all. Lets callers distinguish
 * "no handoff link" from "a handoff link that failed validation" — both of
 * which decodeGraphFragment reports as null — so a rejected payload can still
 * be scrubbed from the URL.
 */
export const hasGraphFragment = (hash: string): boolean => GRAPH_FRAGMENT_RE.test(hash);

/**
 * Decode a `#graph=<encoded>` fragment into a resource map. Returns null when
 * the fragment is absent, empty, malformed, or not a valid create-only graph
 * (never throws).
 */
export const decodeGraphFragment = async (hash: string): Promise<ResourceMap | null> => {
    const match = GRAPH_FRAGMENT_RE.exec(hash);
    if (!match) {
        return null;
    }
    try {
        const bytes = base64urlToBytes(match[1]);
        const json = await bytesToText(bytes);
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        const entries = Object.entries(parsed);
        if (entries.length === 0) {
            return null;
        }
        // Reject the whole payload unless every resource is create-only and
        // well-formed; a partial hydrate of a tampered graph is worse than none.
        if (!entries.every(([id, value]) => isCreateOnlyResource(id, value))) {
            return null;
        }
        return parsed as ResourceMap;
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
