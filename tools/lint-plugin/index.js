// Local Oxlint plugin for Duely-specific rules.
// FR-14.2 / SPEC 4.5: every time-dependent code path reads the clock service, so raw "now" is banned.
const isDateIdentifier = (node) => node?.type === "Identifier" && node.name === "Date";

const noRawDate = {
  meta: {
    type: "problem",
    messages: {
      raw: "Use the clock service instead of a raw current-time read (`@repo/clock`). `new Date(value)` with an argument is fine.",
    },
  },
  create(context) {
    return {
      NewExpression(node) {
        if (isDateIdentifier(node.callee) && node.arguments.length === 0) {
          context.report({ node, messageId: "raw" });
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        const isNow =
          callee.type === "MemberExpression" &&
          isDateIdentifier(callee.object) &&
          callee.property.type === "Identifier" &&
          callee.property.name === "now";
        if (isNow || isDateIdentifier(callee)) context.report({ node, messageId: "raw" });
      },
    };
  },
};

export default {
  meta: { name: "duely" },
  rules: { "no-raw-date": noRawDate },
};
