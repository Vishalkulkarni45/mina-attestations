import { Field, Poseidon, PrivateKey, Proof, PublicKey, Struct } from 'o1js';
import {
  Spec,
  type Input,
  type Claims,
  type PublicInputs,
  type ContextInput,
} from './program-spec.ts';
import { createProgram, type Program } from './program.ts';
import {
  signCredentials,
  type CredentialType,
  type StoredCredential,
} from './credential.ts';
import { assert } from './util.ts';
import { generateContext, computeContext } from './program-spec.ts';
import { NestedProvable } from './nested.ts';

export { PresentationRequest, Presentation };

type InputContext = {
  action: string | Field;
  serverNonce: Field;
};

type WalletContext = {
  verifierIdentity: string | PublicKey;
  clientNonce: Field;
};

type ContextConfig = {
  type: 'zk-app' | 'https';
  presentationCircuitVKHash: Field;
};

type PresentationRequest<
  Output = any,
  Inputs extends Record<string, Input> = Record<string, Input>
> = {
  programSpec: Spec<Output, Inputs>;
  claims: Claims<Inputs>;
  inputContext?: InputContext;

  deriveContext(walletContext?: WalletContext): Field;
};

const PresentationRequest = {
  noContext<Output, Inputs extends Record<string, Input>>(
    programSpec: Spec<Output, Inputs>,
    claims: Claims<Inputs>
  ) {
    return {
      programSpec,
      claims,
      deriveContext: () => Field(0),
    } satisfies PresentationRequest;
  },

  withContext<Output, Inputs extends Record<string, Input>>(
    programSpec: Spec<Output, Inputs>,
    claims: Claims<Inputs>,
    contextConfig: ContextConfig,
    inputContext: InputContext
  ): PresentationRequest<Output, Inputs> {
    const { type, presentationCircuitVKHash } = contextConfig;
    const { action, serverNonce } = inputContext;

    const claimsType = NestedProvable.fromValue(claims);
    const claimsFields = Struct(claimsType).toFields(claims);
    const claimsHash = Poseidon.hash(claimsFields);
    return {
      programSpec,
      claims,
      deriveContext: (walletContext: WalletContext) => {
        const { verifierIdentity, clientNonce } = walletContext;

        const contextParams = {
          type,
          presentationCircuitVKHash,
          clientNonce,
          serverNonce,
          verifierIdentity,
          action,
          claims: claimsHash,
        } as ContextInput;

        const computedContext = computeContext(contextParams);

        const generatedContext = generateContext(computedContext);

        return generatedContext;
      },
    } satisfies PresentationRequest;
  },
};

type Presentation<Output, Inputs extends Record<string, Input>> = {
  version: 'v0';
  claims: Claims<Inputs>;
  outputClaim: Output;
  proof: Proof<PublicInputs<Inputs>, Output>;
};

type Output<R> = R extends PresentationRequest<infer O> ? O : never;
type Inputs<R> = R extends PresentationRequest<any, infer I> ? I : never;

const Presentation = {
  async compile<R extends PresentationRequest>(
    request: R
  ): Promise<R & { program: Program<Output<R>, Inputs<R>> }> {
    let program: Program<Output<R>, Inputs<R>> = (request as any).program ??
    createProgram(request.programSpec);
    await program.compile();
    return { ...request, program };
  },

  create: createPresentation,
};

async function createPresentation<Output, Inputs extends Record<string, Input>>(
  ownerKey: PrivateKey,
  {
    request,
    walletContext,
    credentials,
  }: {
    request: PresentationRequest<Output, Inputs>;
    walletContext?: WalletContext;
    credentials: (StoredCredential & { key?: string })[];
  }
): Promise<Presentation<Output, Inputs>> {
  let context = request.deriveContext(walletContext);
  let { program } = await Presentation.compile(request);

  let credentialsNeeded = Object.entries(request.programSpec.inputs).filter(
    (c): c is [string, CredentialType] => c[1].type === 'credential'
  );
  let credentialsUsed = pickCredentials(
    credentialsNeeded.map(([key]) => key),
    credentials
  );
  let ownerSignature = signCredentials(
    ownerKey,
    context,
    ...credentialsNeeded.map(([key, input]) => ({
      ...credentialsUsed[key]!,
      credentialType: input,
    }))
  );

  let proof = await program.run({
    context,
    claims: request.claims,
    ownerSignature,
    credentials: credentialsUsed as any,
  });

  return {
    version: 'v0',
    claims: request.claims,
    outputClaim: proof.publicOutput,
    proof,
  };
}

function pickCredentials(
  credentialsNeeded: string[],
  [...credentials]: (StoredCredential & { key?: string })[]
): Record<string, StoredCredential> {
  let credentialsUsed: Record<string, StoredCredential> = {};
  let credentialsStillNeeded: string[] = [];

  for (let key of credentialsNeeded) {
    let i = credentials.findIndex((c) => c.key === key);
    if (i === -1) {
      credentialsStillNeeded.push(key);
      continue;
    } else {
      credentialsUsed[key] = credentials[i]!;
      credentials.splice(i, 1);
    }
  }
  let i = 0;
  for (let credential of credentials) {
    if (credentialsStillNeeded.length === 0) break;
    credentialsUsed[credentialsStillNeeded.shift()!] = credential;
    i++;
  }
  assert(
    credentialsStillNeeded.length === 0,
    `Missing credentials: ${credentialsStillNeeded.join(', ')}`
  );
  return credentialsUsed;
}
