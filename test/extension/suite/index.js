/* global __dirname, exports, require */
const Mocha = require('mocha');
const path = require('node:path');

exports.run = () => {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20_000 });
  mocha.addFile(path.resolve(__dirname, 'extension.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) reject(new Error(`${failures} extension-host test(s) failed.`));
      else resolve();
    });
  });
};
