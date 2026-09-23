import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRuntimePackage } from "../assets/pi-rp-launcher/validate-runtime-package.mjs";

export { validateRuntimePackage };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const card = process.argv[2];
  if (!card) throw new Error("Usage: node validate_runtime_package.mjs <card-directory>");
  const result = await validateRuntimePackage(card);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
