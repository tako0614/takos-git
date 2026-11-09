import { expect, test } from "bun:test";
import { createMemo, createRoot, createSignal } from "solid-js";
import { createCommentSubmission } from "./comment-submission.ts";

test("a restored flow created in a memo does not depend on its own recovery signals", () => {
  const values = new Map<string, string>();
  const storage = { getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);} };
  const options = { storage:()=>storage, scope:"A".repeat(43), repositoryId:"repo-a", issueId:"issue-a" };
  const original = createCommentSubmission(options);
  original.begin({ body:"pending original", revision:1, closeAfter:"closed", idempotencyKey:"retained-key", context:original.context });
  original.saveDraft("newer draft",3);
  createRoot(dispose => {
    let constructions=0;
    const [generation,setGeneration]=createSignal(0);
    const flow=createMemo(()=>{
      generation();
      if(++constructions>3) throw new Error("Recovery factory tracked its own signals");
      return createCommentSubmission(options);
    });
    try {
      expect(flow().unknown()?.idempotencyKey).toBe("retained-key");expect(constructions).toBe(1);
      expect(flow().retry(flow().unknown()!)).toBe(true);expect(constructions).toBe(1);
      flow().fail(flow().state()!.attempt,new TypeError("Lost reply"));expect(constructions).toBe(1);
      setGeneration(1);expect(flow().restoredForm()).toEqual({body:"newer draft",revision:3});expect(constructions).toBe(2);
    } finally { dispose(); }
  });
});
