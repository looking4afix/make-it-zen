"use strict";
// Shared helpers: load an extension source file by path relative to the repo root.
const fs = require("fs");
const path = require("path");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
// Objects built inside a vm context have another Object.prototype: compare through JSON.
const J = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { read, J, sleep };
