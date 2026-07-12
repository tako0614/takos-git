import type {
  ObjectStoreBinding,
  ObjectStoreListResult,
  ObjectStoreObjectBody,
  ObjectStoreObjectHead,
  ObjectStorePutOptions,
} from "./types.ts";

const REPOSITORY_PREFIX = "git/v3/repos/";

function repositoryPrefix(repo: string): string {
  if (
    !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/u.test(repo) ||
    repo.includes("..")
  ) {
    throw new Error(`invalid repo name: ${repo}`);
  }
  return `${REPOSITORY_PREFIX}${repo}/`;
}

export function repositoryObjectStore(
  bucket: ObjectStoreBinding,
  repo: string,
): ObjectStoreBinding {
  const prefix = repositoryPrefix(repo);
  const key = (value: string): string => `${prefix}${value}`;
  return {
    async get(value): Promise<ObjectStoreObjectBody | null> {
      const object = await bucket.get(key(value));
      return object
        ? {
            key: object.key.slice(prefix.length),
            etag: object.etag,
            arrayBuffer: () => object.arrayBuffer(),
          }
        : null;
    },
    async head(value): Promise<ObjectStoreObjectHead | null> {
      const object = await bucket.head(key(value));
      return object
        ? { key: object.key.slice(prefix.length), etag: object.etag }
        : null;
    },
    async put(
      value: string,
      body: Uint8Array | ArrayBuffer | ReadableStream | string,
      options?: ObjectStorePutOptions,
    ): Promise<ObjectStoreObjectHead | null> {
      const object = await bucket.put(key(value), body, options);
      return object
        ? { key: object.key.slice(prefix.length), etag: object.etag }
        : null;
    },
    async delete(value: string | string[]): Promise<void> {
      await bucket.delete(
        Array.isArray(value) ? value.map((item) => key(item)) : key(value),
      );
    },
    async list(options = {}): Promise<ObjectStoreListResult> {
      const page = await bucket.list({
        ...options,
        prefix: `${prefix}${options.prefix ?? ""}`,
      });
      return {
        ...page,
        objects: page.objects.map((object) => ({
          key: object.key.slice(prefix.length),
        })),
      };
    },
  };
}

export async function deleteRepositoryObjects(
  bucket: ObjectStoreBinding,
  repo: string,
): Promise<number> {
  const prefix = repositoryPrefix(repo);
  let deleted = 0;
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000 });
    if (page.objects.length === 0) break;
    await bucket.delete(page.objects.map((object) => object.key));
    deleted += page.objects.length;
  }
  return deleted;
}
