'use strict';
// What Claude chats ask permission for, answered in the window (see electron/approvals.cjs).
const approvals = require('../approvals.cjs');

module.exports = {
  handlers: {
    'approvals': () => ({ approvals: approvals.list(), rules: approvals.rules() }),
    // choice: 'once' | 'always' | 'deny'
    'approval:answer': (id, choice, message) => approvals.answer(id, choice, message),
    // Take back "Always allow" for one tool in a chat, or for every tool when tool is empty.
    'approval:forget': (chat, tool) => approvals.forget(chat, tool),
  },
};
