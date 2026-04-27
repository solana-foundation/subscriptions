import { GILL_EXTERNAL_MODULE_MAP } from 'gill';

const GILL_CODAMA_MODULE_MAP = {
  ...GILL_EXTERNAL_MODULE_MAP,
  solanaErrors: '@solana/kit',
  solanaPrograms: '@solana/kit',
  solanaProgramClientCore: '@solana/kit/program-client-core',
};

export default {
  idl: './programs/subscriptions/idl/subscriptions.json',
  before: [
    './codama-visitors.mjs#addEventAuthorityPda',
    './codama-visitors.mjs#setEventAuthorityAndSelfProgramDefaults',
  ],
  scripts: {
    js: {
      from: '@codama/renderers-js',
      args: [
        './clients/typescript/src/generated',
        {
          generatedFolder: '.',
          dependencyMap: GILL_CODAMA_MODULE_MAP,
          dependencyVersions: {
            '@solana/kit/program-client-core': '^5.5.1',
            gill: '^0.14.0',
          },
        },
      ],
    },
    rust: {
      from: '@codama/renderers-rust',
      args: [
        './clients/rust',
        {
          crateFolder: 'clients/rust',
          formatCode: true,
        },
      ],
    },
  },
};
