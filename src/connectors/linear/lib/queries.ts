// Named GraphQL query/mutation strings for the Linear connector.
// Field selections are intentionally lean — only what handlers surface.

export const GET_ISSUE = `
  query GetIssue($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      priority
      url
      archivedAt
      createdAt
      updatedAt
      state { id name type }
      assignee { id name email displayName }
      team { id key name }
      labels { nodes { id name color } }
    }
  }
`;

export const SEARCH_ISSUES = `
  query SearchIssues($filter: IssueFilter, $first: Int) {
    issues(filter: $filter, first: $first) {
      nodes {
        id
        identifier
        title
        priority
        url
        createdAt
        updatedAt
        state { name type }
        assignee { displayName email }
        team { key name }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const GET_PROJECT = `
  query GetProject($id: String!) {
    project(id: $id) {
      id
      name
      description
      state
      startDate
      targetDate
      createdAt
      updatedAt
    }
  }
`;

export const GET_TEAM = `
  query GetTeam($id: String!) {
    team(id: $id) {
      id
      key
      name
      description
    }
  }
`;

export const TEAMS_BY_KEY = `
  query TeamsByKey($key: String!) {
    teams(filter: { key: { eq: $key } }) {
      nodes {
        id
        key
        name
        description
      }
    }
  }
`;

export const GET_COMMENTS = `
  query GetComments($id: String!, $first: Int) {
    issue(id: $id) {
      comments(first: $first) {
        nodes {
          id
          body
          createdAt
          updatedAt
          user { id name displayName email }
        }
        pageInfo { hasNextPage }
      }
    }
  }
`;

export const LIST_ATTACHMENTS = `
  query ListAttachments($id: String!) {
    issue(id: $id) {
      attachments {
        nodes {
          id
          title
          subtitle
          url
          createdAt
          creator { displayName }
        }
      }
    }
  }
`;

// Mutations

export const CREATE_ISSUE = `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        url
        title
        createdAt
      }
    }
  }
`;

export const UPDATE_ISSUE = `
  mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        id
        identifier
        updatedAt
      }
    }
  }
`;

export const ARCHIVE_ISSUE = `
  mutation ArchiveIssue($id: String!) {
    issueArchive(id: $id) {
      success
    }
  }
`;

export const ADD_COMMENT = `
  mutation AddComment($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment {
        id
        body
        createdAt
        user { displayName }
      }
    }
  }
`;

export const UPDATE_COMMENT = `
  mutation UpdateComment($id: String!, $input: CommentUpdateInput!) {
    commentUpdate(id: $id, input: $input) {
      success
      comment {
        id
        body
        updatedAt
      }
    }
  }
`;

export const DELETE_COMMENT = `
  mutation DeleteComment($id: String!) {
    commentDelete(id: $id) {
      success
    }
  }
`;

export const ATTACHMENT_LINK = `
  mutation AttachmentLink($input: AttachmentCreateInput!) {
    attachmentCreate(input: $input) {
      success
      attachment {
        id
        title
        url
        createdAt
      }
    }
  }
`;
