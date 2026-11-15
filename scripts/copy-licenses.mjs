import {copyFile} from 'node:fs/promises';
for(const file of ['LICENSE.md','THIRD_PARTY_NOTICES']) await copyFile(file,'dist/web/'+file);
