import { defineConfig } from "eslint/config";
import raycastConfig from "@raycast/eslint-config";

export default defineConfig([{ ignores: [".agents/**", "tmp/**", "dist/**", "raycast-env.d.ts"] }, ...raycastConfig]);
