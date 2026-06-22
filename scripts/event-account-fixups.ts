import {
    constantPdaSeedNode,
    pdaNode,
    pdaValueNode,
    programIdValueNode,
    setInstructionAccountDefaultValuesVisitor,
    stringTypeNode,
    stringValueNode,
} from 'codama';

export const eventAccountDefaultsVisitor = () =>
    setInstructionAccountDefaultValuesVisitor([
        { account: 'selfProgram', defaultValue: programIdValueNode() },
        {
            account: 'eventAuthority',
            defaultValue: pdaValueNode(
                pdaNode({
                    name: 'eventAuthority',
                    seeds: [constantPdaSeedNode(stringTypeNode('utf8'), stringValueNode('event_authority'))],
                }),
            ),
        },
    ]);
