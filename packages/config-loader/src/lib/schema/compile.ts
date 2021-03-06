/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Ajv from 'ajv';
import { JSONSchema7 as JSONSchema } from 'json-schema';
import mergeAllOf, { Resolvers } from 'json-schema-merge-allof';
import { ConfigReader } from '@backstage/config';
import {
  ConfigSchemaPackageEntry,
  ValidationFunc,
  CONFIG_VISIBILITIES,
  ConfigVisibility,
} from './types';

/**
 * This takes a collection of Backstage configuration schemas from various
 * sources and compiles them down into a single schema validation function.
 *
 * It also handles the implementation of the custom "visibility" keyword used
 * to specify the scope of different config paths.
 */
export function compileConfigSchemas(
  schemas: ConfigSchemaPackageEntry[],
): ValidationFunc {
  // The ajv instance below is stateful and doesn't really allow for additional
  // output during validation. We work around this by having this extra piece
  // of state that we reset before each validation.
  const visibilityByPath = new Map<string, ConfigVisibility>();

  const ajv = new Ajv({
    allErrors: true,
    schemas: {
      'https://backstage.io/schema/config-v1': true,
    },
  }).addKeyword('visibility', {
    metaSchema: {
      type: 'string',
      enum: CONFIG_VISIBILITIES,
    },
    compile(visibility: ConfigVisibility) {
      return (_data, dataPath) => {
        if (!dataPath) {
          return false;
        }
        if (visibility && visibility !== 'backend') {
          const normalizedPath = dataPath.replace(
            /\['?(.*?)'?\]/g,
            (_, segment) => `.${segment}`,
          );
          visibilityByPath.set(normalizedPath, visibility);
        }
        return true;
      };
    },
  });

  const merged = mergeAllOf(
    { allOf: schemas.map(_ => _.value) },
    {
      // JSONSchema is typically subtractive, as in it always reduces the set of allowed
      // inputs through constraints. This changes the object property merging to be additive
      // rather than subtractive.
      ignoreAdditionalProperties: true,
      resolvers: {
        // This ensures that the visibilities across different schemas are sound, and
        // selects the most specific visibility for each path.
        visibility(values: string[], path: string[]) {
          const hasFrontend = values.some(_ => _ === 'frontend');
          const hasSecret = values.some(_ => _ === 'secret');
          if (hasFrontend && hasSecret) {
            throw new Error(
              `Config schema visibility is both 'frontend' and 'secret' for ${path.join(
                '/',
              )}`,
            );
          } else if (hasFrontend) {
            return 'frontend';
          } else if (hasSecret) {
            return 'secret';
          }

          return 'backend';
        },
      } as Partial<Resolvers<JSONSchema>>,
    },
  );

  const validate = ajv.compile(merged);

  return configs => {
    const config = ConfigReader.fromConfigs(configs).get();

    visibilityByPath.clear();

    const valid = validate(config);
    if (!valid) {
      const errors = validate.errors ?? [];
      return {
        errors: errors.map(({ dataPath, message, params }) => {
          const paramStr = Object.entries(params)
            .map(([name, value]) => `${name}=${value}`)
            .join(' ');
          return `Config ${message || ''} { ${paramStr} } at ${dataPath}`;
        }),
        visibilityByPath: new Map(),
      };
    }

    return {
      visibilityByPath: new Map(visibilityByPath),
    };
  };
}
