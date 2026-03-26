import { execFileSync } from "node:child_process";

function ghGraphql(query, variables = {}) {
  const out = execFileSync(
    "gh",
    ["api", "graphql", "-f", `query=${query}`, "-f", `variables=${JSON.stringify(variables)}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  return JSON.parse(out);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const ORG = process.env.ORG;
const PROJECT_NUMBER = Number(process.env.PROJECT_NUMBER);
const STATUS_NAME = process.env.STATUS_NAME || "Status";
const STATUS_VALUE = process.env.STATUS_VALUE || "In Review";

if (!process.env.GH_TOKEN) {
  throw new Error("Missing GH_TOKEN (set secrets.PROJECT_AUTOMATION_TOKEN).");
}
if (!ORG || !PROJECT_NUMBER) {
  throw new Error("Missing ORG or PROJECT_NUMBER env vars.");
}

const getProjectQuery = `
query($org: String!, $number: Int!) {
  organization(login: $org) {
    projectV2(number: $number) {
      id
      title
      fields(first: 100) {
        nodes {
          __typename
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}
`;

const projectRes = ghGraphql(getProjectQuery, { org: ORG, number: PROJECT_NUMBER });
const project = projectRes?.data?.organization?.projectV2;
if (!project?.id) {
  throw new Error(`Could not find org project ${ORG} #${PROJECT_NUMBER}`);
}

const statusField = (project.fields.nodes || []).find(
  (f) => f?.__typename === "ProjectV2SingleSelectField" && f?.name === STATUS_NAME
);
if (!statusField) {
  throw new Error(`Could not find single-select field named '${STATUS_NAME}' on project.`);
}
const statusOption = (statusField.options || []).find((o) => o?.name === STATUS_VALUE);
if (!statusOption) {
  const options = (statusField.options || []).map((o) => o.name).filter(Boolean);
  throw new Error(
    `Could not find option '${STATUS_VALUE}' in field '${STATUS_NAME}'. Options: ${options.join(", ")}`
  );
}

const listItemsQuery = `
query($projectId: ID!, $after: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                field { ... on ProjectV2SingleSelectField { id name } }
                optionId
                name
              }
            }
          }
          content {
            __typename
            ... on Issue {
              id
              number
              title
              state
              url
              repository { nameWithOwner }
            }
          }
        }
      }
    }
  }
}
`;

const closeIssueMutation = `
mutation($issueId: ID!) {
  closeIssue(input: { issueId: $issueId }) {
    issue { id state url }
  }
}
`;

let after = null;
let scanned = 0;
let closed = 0;

while (true) {
  const res = ghGraphql(listItemsQuery, { projectId: project.id, after });
  const items = res?.data?.node?.items;
  if (!items) break;

  for (const item of items.nodes || []) {
    scanned++;

    const content = item.content;
    if (!content || content.__typename !== "Issue") continue;
    if (content.state !== "OPEN") continue;

    const fv = item.fieldValues?.nodes || [];
    const statusValueNode = fv.find(
      (n) =>
        n?.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
        n?.field?.id === statusField.id
    );

    if (!statusValueNode) continue;
    if (statusValueNode.optionId !== statusOption.id) continue;

    console.log(
      `Closing ${content.repository.nameWithOwner}#${content.number}: ${content.title} (${content.url})`
    );

    ghGraphql(closeIssueMutation, { issueId: content.id });
    closed++;

    // tiny delay to be polite with API rate limits
    await sleep(200);
  }

  if (!items.pageInfo.hasNextPage) break;
  after = items.pageInfo.endCursor;
}

console.log(`Done. Scanned ${scanned} project items. Closed ${closed} issues.`);