import {
  VerificationKey,
  DynamicProof,
  type InferProvable,
  FeatureFlags,
  Proof,
  Poseidon,
  verify,
  Cache,
  ZkProgram,
  Provable,
  PublicKey,
  Undefined,
} from 'o1js';
import { ProvableType } from './o1js-missing.ts';
import {
  type InferNestedProvable,
  NestedProvable,
  type NestedProvableFor,
} from './nested.ts';
import { prefixes } from './constants.ts';
import {
  type CredentialSpec,
  type Credential,
  type StoredCredential,
  defineCredential,
  credentialHash,
  hashCredentialInCircuit,
  withOwner,
} from './credential.ts';
import { assert } from './util.ts';

export { Recursive, type Witness };

type Witness<Data = any, Input = any> = {
  type: 'recursive';
  vk: VerificationKey;
  proof: DynamicProof<Input, Credential<Data>>;
};

type Recursive<Data, Input> = StoredCredential<
  Data,
  Witness<Data, Input>,
  undefined
>;

function Recursive<
  DataType extends NestedProvable,
  InputType extends ProvableType,
  Data extends InferNestedProvable<DataType>,
  Input extends InferProvable<InputType>
>(
  Proof: typeof DynamicProof<Input, Credential<Data>>,
  dataType: DataType
): CredentialSpec<'recursive', Witness<Data, Input>, Data> {
  // TODO annoying that this cast doesn't work without overriding the type
  const data: NestedProvableFor<Data> = dataType as any;

  return {
    type: 'credential',
    credentialType: 'recursive',
    witness: {
      type: ProvableType.constant('recursive'),
      vk: VerificationKey,
      proof: Proof,
    },
    data: NestedProvable.get(data),

    // verify the proof, check that its public output is exactly the credential
    verify({ vk, proof }, credHash) {
      proof.verify(vk);
      hashCredentialInCircuit(data, proof.publicOutput).hash.assertEquals(
        credHash.hash,
        'Invalid proof output'
      );
    },
    async verifyOutsideCircuit({ vk, proof }, credHash) {
      let ok = await verify(proof, vk);
      assert(ok, 'Invalid proof');
      hashCredentialInCircuit(data, proof.publicOutput).hash.assertEquals(
        credHash.hash,
        'Invalid proof output'
      );
    },

    // issuer == hash of vk and public input
    issuer({ vk, proof }) {
      let credIdent = Poseidon.hash(
        Proof.publicInputType.toFields(proof.publicInput)
      );
      return Poseidon.hashWithPrefix(prefixes.issuerRecursive, [
        vk.hash,
        credIdent,
      ]);
    },
  };
}

const genericRecursive = defineCredential({
  credentialType: 'recursive',
  witness: {
    type: ProvableType.constant('recursive'),
    vk: VerificationKey,
    proof: DynamicProof,
  },

  // verify the proof, check that its public output is exactly the credential
  verify({ vk, proof }, credHash) {
    proof.verify(vk);
    credentialHash(proof.publicOutput).assertEquals(
      credHash.hash,
      'Invalid proof output'
    );
  },
  async verifyOutsideCircuit({ vk, proof }, credHash) {
    let ok = await verify(proof, vk);
    assert(ok, 'Invalid proof');
    credentialHash(proof.publicOutput).assertEquals(
      credHash.hash,
      'Invalid proof output'
    );
  },

  // issuer == hash of vk and public input
  issuer({ vk, proof }) {
    let credIdent = Poseidon.hash(
      (proof.constructor as typeof DynamicProof).publicInputType.toFields(
        proof.publicInput
      )
    );
    return Poseidon.hashWithPrefix(prefixes.issuerRecursive, [
      vk.hash,
      credIdent,
    ]);
  },
});

Recursive.Generic = genericRecursive;

Recursive.fromProgram = recursiveFromProgram;
Recursive.fromMethod = recursiveFromMethod;

async function recursiveFromProgram<
  DataType extends ProvableType,
  InputType extends ProvableType,
  Data extends InferProvable<DataType>,
  Input extends InferProvable<InputType>,
  AllInputs extends any[]
>(program: {
  publicInputType: InputType;
  publicOutputType: ProvableType<Credential<Data>>;
  analyzeMethods(): Promise<Record<string, any>>;
  maxProofsVerified(): Promise<0 | 1 | 2>;
  compile: (options?: {
    cache?: Cache;
    forceRecompile?: boolean;
    proofsEnabled?: boolean;
  }) => Promise<{ verificationKey: VerificationKey }>;

  run(...inputs: AllInputs): Promise<{
    proof: Proof<Input, Credential<Data>>;
    auxiliaryOutput: undefined;
  }>;
}) {
  const featureFlags = await FeatureFlags.fromZkProgram(program);
  const maxProofsVerified = await program.maxProofsVerified();

  class InputProof extends DynamicProof<Input, Credential<Data>> {
    static publicInputType: Provable<Input> = ProvableType.get(
      program.publicInputType
    );
    static publicOutputType = ProvableType.get(program.publicOutputType);
    static maxProofsVerified = maxProofsVerified;
    static featureFlags = featureFlags;
  }

  let data = ProvableType.synthesize(program.publicOutputType).data;
  let dataType = NestedProvable.get(NestedProvable.fromValue(data));

  let isCompiled = false;
  let vk: VerificationKey | undefined;

  return Object.assign(
    Recursive<Provable<Data>, InputType, Data, Input>(InputProof, dataType),
    {
      program,

      async create(...inputs: AllInputs) {
        let vk = await this.compile();
        let { proof } = await program.run(...inputs);
        return this.fromProof(proof, vk);
      },

      async fromProof(
        proof: Proof<Input, Credential<Data>>,
        vk: VerificationKey
      ): Promise<Recursive<Data, Input>> {
        let dynProof = InputProof.fromProof(proof);
        return {
          version: 'v0',
          metadata: undefined,
          credential: proof.publicOutput,
          witness: { type: 'recursive', vk, proof: dynProof },
        };
      },

      async compile(options?: {
        cache?: Cache;
        forceRecompile?: boolean;
        proofsEnabled?: boolean;
      }) {
        if (isCompiled) return vk!;
        let result = await program.compile(options);
        vk = result.verificationKey;
        isCompiled = true;
        return vk;
      },

      async dummy(
        credential: Credential<Data>
      ): Promise<Recursive<Data, Input>> {
        let input = ProvableType.synthesize(program.publicInputType);
        let vk = await this.compile();

        let dummyProof = await InputProof.dummy(
          input,
          credential,
          maxProofsVerified
        );
        return {
          version: 'v0',
          metadata: undefined,
          credential,
          witness: { type: 'recursive', vk, proof: dummyProof },
        };
      },
    }
  );
}

type PublicInput<Config> = InferProvableOrUndefined<Get<Config, 'public'>>;
type PrivateInput<Config> = InferProvable<Get<Config, 'private'>>;
type Data<Config> = InferProvable<Get<Config, 'data'>>;

async function recursiveFromMethod<
  Config extends {
    name: string;
    public?: NestedProvable;
    private?: NestedProvable;
    data: NestedProvable;
  }
>(
  spec: Config,
  method: (inputs: {
    public: PublicInput<Config>;
    private: PrivateInput<Config>;
    owner: PublicKey;
  }) => Promise<Data<Config>>
) {
  type PublicInput = InferProvableOrUndefined<Get<Config, 'public'>>;
  type PrivateInput = InferProvable<Get<Config, 'private'>>;
  type Data = InferProvable<Get<Config, 'data'>>;

  let publicInput =
    spec.public === undefined
      ? undefined
      : NestedProvable.get<PublicInput>(
          spec.public as NestedProvableFor<PublicInput>
        );
  let privateInput =
    spec.private === undefined
      ? Undefined
      : NestedProvable.get<PrivateInput>(
          spec.private as NestedProvableFor<PrivateInput>
        );
  let publicOutput = NestedProvable.get(withOwner(spec.data));

  async function wrappedMethod(
    pub: PublicInput,
    priv: PrivateInput,
    owner: PublicKey
  ): Promise<{ publicOutput: Credential<Data> }> {
    let data = await method({ public: pub, private: priv, owner });
    return { publicOutput: { owner, data } };
  }

  let program = ZkProgram({
    name: spec.name,
    publicInput,
    publicOutput,
    methods: {
      run: {
        privateInputs: [privateInput, PublicKey],
        method:
          publicInput === undefined
            ? (privateInput: PrivateInput, owner: PublicKey) =>
                wrappedMethod(undefined as any, privateInput, owner)
            : wrappedMethod,
      } as any, // ZkProgram's generics are too stupid
    },
  });

  let credentialSpec = await recursiveFromProgram<
    Provable<Data>,
    Provable<PublicInput>,
    Data,
    PublicInput,
    any
  >(program as any);
  let credentialSpec2: Omit<typeof credentialSpec, 'create'> = credentialSpec;
  return {
    ...credentialSpec2,

    async create(inputs: {
      public: PublicInput;
      private: PrivateInput;
      owner: PublicKey;
    }) {
      let vk = await this.compile();
      let proof: Proof<PublicInput, Credential<Data>>;
      if (publicInput === undefined) {
        ({ proof } = await (program.run as any)(inputs.private, inputs.owner));
      } else {
        ({ proof } = await (program.run as any)(
          inputs.public,
          inputs.private,
          inputs.owner
        ));
      }
      return this.fromProof(proof, vk);
    },
  };
}

type Get<T, Key extends string> = T extends {
  [K in Key]: infer Value;
}
  ? Value
  : undefined;

type InferProvableOrUndefined<A> = A extends undefined
  ? undefined
  : A extends ProvableType
  ? InferProvable<A>
  : InferProvable<A> | undefined;

type MethodWithOwner<PublicInput, PublicOutput, PrivateInput> =
  PublicInput extends undefined
    ? {
        method(
          privateInput: PrivateInput,
          owner: PublicKey
        ): Promise<Credential<PublicOutput>>;
      }
    : {
        method(
          publicInput: PublicInput,
          privateInput: PrivateInput,
          owner: PublicKey
        ): Promise<Credential<PublicOutput>>;
      };
