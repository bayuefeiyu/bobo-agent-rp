import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve,dirname} from "node:path";
import {browseReferenceDirectories} from "./rp-reference-library.mjs";

test("directory browser lists only folders and supports parents and pagination",async()=>{
  const root=await mkdtemp(resolve(tmpdir(),"rp-library-picker-"));
  await Promise.all(Array.from({length:205},(_,index)=>mkdir(resolve(root,"folder-"+index))));
  await writeFile(resolve(root,"private-document.txt"),"Not exposed by the directory browser");
  const first=await browseReferenceDirectories({path:root});
  assert.equal(first.path,root);assert.equal(first.parent,dirname(root));
  assert.equal(first.directories.length,200);assert.equal(first.total,205);assert.equal(first.nextOffset,200);
  assert.ok(first.roots.some(item=>item.name==="用户目录"));assert.ok(!first.directories.some(item=>item.name==="private-document.txt"));
  const second=await browseReferenceDirectories({path:root,offset:first.nextOffset});
  assert.equal(second.directories.length,5);assert.equal(second.nextOffset,null);
  const child=await browseReferenceDirectories({path:first.directories[0].path});
  assert.equal(child.parent,root);assert.equal(child.total,0);
  await assert.rejects(browseReferenceDirectories({path:"relative/path"}),/绝对目录/);
  await assert.rejects(browseReferenceDirectories({path:resolve(root,"private-document.txt")}),/不是目录/);
  await assert.rejects(browseReferenceDirectories({path:root,offset:-1}),/分页参数/);
});
