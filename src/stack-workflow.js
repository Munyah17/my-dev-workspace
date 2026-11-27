export const stackTargets={
  vercel:{
    label:'Vercel',
    setup:'Install vercel in your lockfile. Set VERCEL_ORG_ID and VERCEL_PROJECT_ID as environment variables and VERCEL_TOKEN as an environment secret.',
    steps:`      - name: Deploy to Vercel
        env:
          VERCEL_ORG_ID: \${{ vars.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: \${{ vars.VERCEL_PROJECT_ID }}
          VERCEL_TOKEN: \${{ secrets.VERCEL_TOKEN }}
        run: ./node_modules/.bin/vercel deploy --prod --yes --token "$VERCEL_TOKEN"`,
  },
  cloudflare:{
    label:'Cloudflare Workers',
    setup:'Install wrangler and commit your Wrangler config. Set CLOUDFLARE_ACCOUNT_ID as an environment variable and CLOUDFLARE_API_TOKEN as an environment secret.',
    steps:`      - name: Deploy Cloudflare Worker
        env:
          CLOUDFLARE_ACCOUNT_ID: \${{ vars.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: ./node_modules/.bin/wrangler deploy`,
  },
  firebase:{
    label:'Firebase Hosting',
    setup:'Install firebase-tools, commit firebase.json, and configure Google Workload Identity Federation. Set FIREBASE_PROJECT_ID, GOOGLE_WORKLOAD_IDENTITY_PROVIDER, and GOOGLE_SERVICE_ACCOUNT as environment variables.',
    permissions:'    permissions:\n      contents: read\n      id-token: write\n',
    steps:`      - run: npm run build --if-present
      - uses: google-github-actions/auth@v3
        with:
          workload_identity_provider: \${{ vars.GOOGLE_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: \${{ vars.GOOGLE_SERVICE_ACCOUNT }}
      - name: Deploy Firebase Hosting
        env:
          FIREBASE_PROJECT_ID: \${{ vars.FIREBASE_PROJECT_ID }}
        run: ./node_modules/.bin/firebase deploy --only hosting --project "$FIREBASE_PROJECT_ID" --non-interactive`,
  },
  custom:{
    label:'Repository deploy script',
    setup:'Define npm run deploy:stack for your own target and explicitly wire its scoped secrets into the workflow before committing it.',
    steps:`      - name: Run repository deployment
        run: npm run deploy:stack`,
  },
}

const requestExpression='${{ inputs.request_id }}'
const workflowShaExpression='${{ github.sha }}'
const revisionExpression='${{ inputs.revision }}'
export function buildStackWorkflow(selection){
  const targets=Object.entries(stackTargets).filter(([key])=>selection.includes(key))
  if(!targets.length) return ''
  return `name: MyDev stack release
run-name: MyDev release ${requestExpression}
on:
  workflow_dispatch:
    inputs:
      revision:
        description: Full Git commit SHA to release
        required: true
        type: string
      request_id:
        description: MyDev release request ID
        required: true
        type: string
permissions:
  contents: read
concurrency:
  group: mydev-stack-release
  cancel-in-progress: false
jobs:
  verify:
    name: Verify commit
    runs-on: ubuntu-latest
    steps:
      - name: Validate revision
        env:
          REVISION: ${revisionExpression}
        run: '[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]]'
      - uses: actions/checkout@v4
        with:
          ref: ${revisionExpression}
          fetch-depth: 0
          persist-credentials: false
      - name: Require the release ref to contain this commit
        env:
          WORKFLOW_SHA: ${workflowShaExpression}
        run: git merge-base --is-ancestor HEAD "$WORKFLOW_SHA"
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm ci
      - run: npm test
`+targets.map(([key,target])=>`  ${key}:
    name: Deploy ${target.label}
    needs: verify
    runs-on: ubuntu-latest
    environment: mydev-${key}
${target.permissions??''}    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${revisionExpression}
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm ci
${target.steps}
`).join('')
}
