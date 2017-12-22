import highland from 'highland';
import logger from 'lib/logger';
import { getConnection } from 'lib/connections/mongoose';
import { MongoError, ObjectID } from 'mongodb';

const connection = getConnection();
const attributesCollectionName = 'personaAttributes';
const oldIdentsCollectionName = 'personaidentifiers';
const newIdentsCollectionName = 'personaIdentifiers';
const statementsCollectionName = 'statements';
const personasCollectionName = 'personas';

// Connections
const attributesCollection = connection.collection(attributesCollectionName);
const newIdentsCollection = connection.collection(newIdentsCollectionName);
const statementsCollection = connection.collection(statementsCollectionName);
const personasCollection = connection.collection(personasCollectionName);

const processStream = stream =>
  new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.apply(resolve);
  });

const createNewIdent = (doc) => {
  const { key, value } = doc.uniqueIdentifier;
  let newKey;
  if (/^statement\.actor\./.test(key)) {
    newKey = key.replace('statement.actor.', '');
  }

  return {
    _id: doc._id,
    organisation: doc.organisation,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    persona: doc.persona,
    ifi: {
      key: newKey,
      value,
    }
  };
}

const updateStatementsForFailedIdent = async (failedIdent) => {
  const existingIdent = await newIdentsCollection.findOne({ organisation: new ObjectID(failedIdent.organisation), ifi: failedIdent.ifi });
  const persona = await personasCollection.findOne({ _id: new ObjectID(existingIdent.persona) });
  const personaDisplay =  persona ? persona.name : 'Unknown persona';
  if (existingIdent) {
    console.log(`Convert personaIdentifier ${failedIdent._id} to ${existingIdent._id} with persona name of ${personaDisplay} (${persona._id})`);
    const filter = { organisation: new ObjectID(failedIdent.organisation),  personaIdentifier: new ObjectID(failedIdent._id) };
    const update = {
      $set: {
        personaIdentifier: new ObjectID(existingIdent._id),
        person: {
          _id: new ObjectID(existingIdent.persona),
          display: personaDisplay,
        }
      }
    };
    return statementsCollection.update(filter, update, { multi: true });
  }
}

const insertIdents = async (docs) => {
  // Create new identifiers from old
  const identInserts = docs.map(createNewIdent);
  console.log(`Inserting ${identInserts.length} idents....`);

  try {
    await newIdentsCollection.insertMany(identInserts, {ordered: false});
  } catch (err) {
    if (err instanceof MongoError && err.code === 11000) {
      const failedInserts = err.writeErrors.map((writeError) => {
        return writeError.getOperation();
      })

      const updatePromises = failedInserts.map(updateStatementsForFailedIdent);
      return Promise.all(updatePromises);
    }
  }

  return Promise.resolve();
};

const createAttributesFromIdents = async (docs) => {
  // Create attributes from idents
  const attrBulkOp = attributesCollection.initializeUnorderedBulkOp();
  const attrOps = docs.filter((doc) => {
    const identOps = doc.identifiers.filter(({ key, value }) => {
      if (!/^statement\./.test(key)) {
        const personaId = doc.persona;
        const organisation = doc.organisation;
        const newKey = key.replace('persona.import.', '');
        const attribute = { personaId, organisation, key: newKey, value };
        attrBulkOp.insert(attribute);
        return true;
      }
      return false;
    });
    return identOps.length > 0;
  });

  if (attrOps.length > 0) {
    return attrBulkOp.execute();
  }

  return Promise.resolve();
}

const migrateIdentifierBatch = (docs) => {
  const opsPromises = [
    createAttributesFromIdents(docs),
    insertIdents(docs),
  ];

  return highland(Promise.all(opsPromises));
};

const migrateIdentifiers = async () => {
  const batchSize = 10000;
  const filter = {};
  const collection = connection.collection(oldIdentsCollectionName);
  const docStream = highland(collection.find(filter));
  const migrationStream = docStream.batch(batchSize).flatMap(migrateIdentifierBatch);
  await processStream(migrationStream);
};

const up = async () => {
  await migrateIdentifiers();
  logger.info(`You may want to delete the now unused ${oldIdentsCollectionName} collection`);
};

const down = async () => {
  logger.info('Dropping persona attributes and new idents');
  await connection.collection(newIdentsCollectionName).remove({});
  await connection.collection(attributesCollectionName).remove({});
};

export default { up, down };