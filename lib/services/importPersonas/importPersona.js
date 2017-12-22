import { map } from 'bluebird';
import { head, tail, find } from 'lodash';
import {
  getPersonaName,
  getIfis,
  getAttributes
} from 'lib/services/importPersonas/personasImportHelpers';
import reasignPersonaStatements from 'lib/services/persona/reasignPersonaStatements';
import updateQueryBuilderCache from './updateQueryBuilderCache';

export default ({
  structure,
  organisation,
  personaService,
}) => async (row) => {
  const personaName = getPersonaName({
    structure,
    row
  });

  const ifis = getIfis({
    structure,
    row
  });

  if (ifis.length === 0) {
    // Do nothing, no ifi's to match.
  }

  // Create or update persona identifier
  const personaIdentifiers = await map(
    ifis,
    ifi => personaService.createUpdateIdentifierPersona({
      organisation,
      personaName,
      ifi
    })
  );

  // if created identifier exists, then it is merged.
  const merged = !find(personaIdentifiers, ({ wasCreated }) => wasCreated);

  const personaIds = await map(personaIdentifiers, ({ personaId }) => personaId);
  const toPersonaId = head(personaIds);
  const fromPersonaIds = tail(personaIds);

  // Merge personas
  await map(fromPersonaIds, (fromPersonaId) => {
    if (toPersonaId === fromPersonaId) {
      // Do nothing, as the ifi already points to this persona.
      return;
    }

    return Promise.all([
      personaService.mergePersona({
        organisation,
        toPersonaId,
        fromPersonaId
      }),
      reasignPersonaStatements({
        organisation,
        fromId: fromPersonaId,
        toId: toPersonaId
      })
    ]);
  });

  // Additional infomation
  const attributes = getAttributes({
    structure,
    row
  });

  await map(attributes, (attribute) => {
    personaService.overwritePersonaAttribute({
      organisation,
      personaId: toPersonaId,
      ...attribute
    });
  });

  await updateQueryBuilderCache({
    attributes,
    organisation
  });

  return merged;
};