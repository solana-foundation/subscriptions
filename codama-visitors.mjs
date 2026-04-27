import {
  constantPdaSeedNodeFromString,
  pdaValueNode,
  programIdValueNode,
} from "@codama/nodes";
import {
  addPdasVisitor,
  setInstructionAccountDefaultValuesVisitor,
} from "@codama/visitors";

/// Used to automatically derive the event authority for codama
/// Generated client code will now be able to autofill the eventAuthority
export const addEventAuthorityPda = addPdasVisitor({
  subscriptions: [
    {
      name: "eventAuthority",
      seeds: [constantPdaSeedNodeFromString("utf8", "event_authority")],
    },
  ],
});

export const setEventAuthorityAndSelfProgramDefaults =
  setInstructionAccountDefaultValuesVisitor([
    {
      account: "eventAuthority",
      defaultValue: pdaValueNode("eventAuthority"),
    },
    {
      account: "selfProgram",
      defaultValue: programIdValueNode(),
    },
  ]);
