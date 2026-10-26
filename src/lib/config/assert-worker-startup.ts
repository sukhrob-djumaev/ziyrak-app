import { assertRuntimeConfig } from "./runtime-contract";

/**
 * L2.2: imported first by the worker entrypoint (right after dotenv). Other modules validate single variables at import
 * time (for example JWT_SECRET) and would fail with one cryptic error before the contract could list everything that is
 * wrong, so the contract runs before any of them load.
 */
assertRuntimeConfig(process.env, "worker");
