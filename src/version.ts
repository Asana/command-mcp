import packageJson from "../package.json" with { type: "json" };

export const SERVER_VERSION: string = packageJson.version;
