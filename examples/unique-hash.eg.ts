import { Bytes, Field } from 'o1js';
import {
  Spec,
  Operation,
  Claim,
  Credential,
  Presentation,
  PresentationRequest,
  assert,
  type InferSchema,
} from '../src/index.ts';
import {
  issuer,
  issuerKey,
  owner,
  ownerKey,
  randomPublicKey,
} from '../tests/test-utils.ts';
import { array } from '../src/o1js-missing.ts';

// example schema of the credential, which has enough entropy to be hashed into a unique id
const Bytes32 = Bytes(32);
const Bytes16 = Bytes(16); // 16 bytes = 128 bits = enough entropy

const Schema = { nationality: Bytes32, id: Bytes16 };

// ---------------------------------------------
// ISSUER: issue a signed credential to the owner

let data: InferSchema<typeof Schema> = {
  nationality: Bytes32.fromString('United States of America'),
  id: Bytes16.random(),
};
let credential = Credential.sign(issuerKey, { owner, data });
let credentialJson = Credential.toJSON(credential);

console.log('✅ ISSUER: issued credential:', credentialJson);

// ---------------------------------------------
// WALLET: deserialize, validate and store the credential

let storedCredential = Credential.fromJSON(credentialJson);

await Credential.validate(storedCredential);

console.log('✅ WALLET: imported and validated credential');

// ---------------------------------------------
// VERIFIER: request a presentation

const spec = Spec(
  {
    signedData: Credential.Simple(Schema), // schema needed here!
    targetNations: Claim(array(Bytes32, 3)), // TODO would make more sense as dynamic array
    targetIssuers: Claim(array(Field, 3)),
    appId: Claim(Bytes32),
  },
  ({ signedData, targetNations, targetIssuers, appId }) => ({
    // we assert that:
    // 1. the owner has one of the accepted nationalities
    // 2. the credential was issued by one of the accepted issuers
    assert: Operation.and(
      Operation.equalsOneOf(
        Operation.property(signedData, 'nationality'),
        targetNations
      ),
      Operation.equalsOneOf(Operation.issuer(signedData), targetIssuers)
    ),
    // we expose a unique hash of the credential data, to be used as nullifier
    ouputClaim: Operation.record({
      nullifier: Operation.hash(signedData, appId),
    }),
  })
);

const targetNations = ['United States of America', 'Canada', 'Mexico'];
const targetIssuers = [issuer, randomPublicKey(), randomPublicKey()];

let request = PresentationRequest.https(
  spec,
  {
    targetNations: targetNations.map((s) => Bytes32.fromString(s)),
    targetIssuers: targetIssuers.map((pk) => Credential.Simple.issuer(pk)),
    appId: Bytes32.fromString('my-app-id:123'),
  },
  { action: 'my-app-id:123:authenticate' }
);
let requestJson = PresentationRequest.toJSON(request);

console.log('✅ VERIFIER: created presentation request:', requestJson);

// ---------------------------------------------
// WALLET: deserialize request and create presentation

console.time('compile');
let deserialized = PresentationRequest.fromJSON('https', requestJson);
let compiled = await Presentation.compile(deserialized);
console.timeEnd('compile');

console.time('create');
let presentation = await Presentation.create(ownerKey, {
  request: compiled,
  credentials: [storedCredential],
  context: { verifierIdentity: 'my-app.xyz' },
});
console.timeEnd('create');

let serialized = Presentation.toJSON(presentation);
console.log(
  '✅ WALLET: created presentation:',
  serialized.slice(0, 1000) + '...'
);

// ---------------------------------------------
// VERIFIER: verify the presentation against the request we submitted, and check that the nullifier was not used yet

let presentation2 = Presentation.fromJSON(serialized);
let outputClaim = await Presentation.verify(request, presentation2, {
  verifierIdentity: 'my-app.xyz',
});
console.log('✅ VERIFIER: verified presentation');

let existingNullifiers = new Set([0x13c43f30n, 0x370f3473n, 0xe1fe0cdan]);

// TODO: claims and other I/O values should be plain JS types
let { nullifier } = outputClaim;
assert(
  !existingNullifiers.has(nullifier.toBigInt()),
  'Nullifier should be unique'
);
console.log('✅ VERIFIER: checked nullifier uniqueness');
