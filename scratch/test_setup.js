require('dotenv').config();
const { runSetup } = require('../scripts/setupAws');

runSetup().then(() => {
    console.log("TEST SUCCESSFUL");
    process.exit(0);
}).catch(err => {
    console.error("TEST FAILED", err);
    process.exit(1);
});
