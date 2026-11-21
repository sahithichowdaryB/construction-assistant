import { config } from "../config.js";
import { createDiskStorage } from "./storage.js";

export const imageStorage = createDiskStorage(config.imageDir);
export const audioStorage = createDiskStorage(config.uploadDir);
