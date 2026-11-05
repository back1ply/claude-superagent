// Stands in for gh and glab in local-only tests: any call leaves a marker and fails.

import fs from 'node:fs'

fs.writeFileSync(process.env.TRIPWIRE, process.argv.slice(2).join(' '))
process.exit(1)
