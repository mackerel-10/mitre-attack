import { STIXAttributesToTypeDB, STIXEntityToTypeDB } from './type-mapping';
import logger from '../logger';

class STIXInsertGenerator {
  STIXObjectList: STIXObject[];

  constructor(STIXObjectList: STIXObject[]) {
    this.STIXObjectList = STIXObjectList;
  }

  referencedSTIXObjects() {
    // Get reference id
    const referencedIds: Set<string> = new Set();
    for (const STIXObject of this.STIXObjectList) {
      const createdByRef: string | undefined = STIXObject.created_by_ref;
      if (createdByRef && !referencedIds.has(createdByRef)) {
        referencedIds.add(createdByRef);
      }
    }

    // Generate insert query of reference STIX object
    const queryList: Set<string> = new Set();
    for (const STIXObject of this.STIXObjectList) {
      for (const referencedId of referencedIds) {
        if (STIXObject.id === referencedId) {
          let entityType: string = STIXEntityToTypeDB(STIXObject.type).type;
          if (entityType === 'identity') {
            entityType = STIXObject.identity_class;
          }
          const query = `insert $x isa ${entityType}, ${this.attribute(STIXObject)};`;
          queryList.add(query);
        }
      }
    }

    logger.info(
      `Generated ${queryList.size} insert queries for referenced STIX entities`,
    );
    return {
      referencedQueryList: [...queryList],
      referencedProcessedIds: [...referencedIds],
    };
  }

  statementMarkings() {
    const queryList: Set<string> = new Set();
    const processedIds: Set<string> = new Set();

    for (const STIXObject of this.STIXObjectList) {
      if (
        STIXObject.type === 'marking-definition' &&
        STIXObject.definition_type === 'statement'
      ) {
        processedIds.add(STIXObject.id);
        queryList.add(`
          insert $x isa statement-marking,
            has stix-id '${STIXObject.id}',
            has statement '${STIXObject.definition.statement}',
            has created '${STIXObject.created}',
            has spec-version '${STIXObject.spec_version}';
        `);
      }
    }

    logger.info(`Generated ${queryList.size} insert queries for markings`);
    return {
      markingsQueryList: [...queryList],
      markingsProcessedIds: [...processedIds],
    };
  }

  STIXObjectsAndMarkingRelations(excludeIds: string[]) {
    const STIXEntityQueryList: Set<Query> = new Set();
    const STIXObjectsWithMarkingRefs: STIXObject[] = [];
    const ignoreDeprecated: boolean = Boolean(
      JSON.parse(process.env.IGNORE_DEPRECATED!),
    );
    let ignoredObjects: number = 0;

    for (const STIXObject of this.STIXObjectList) {
      const STIXObjectType: string = STIXObject.type;

      // Don't insert the object if it's deprecated.
      // x_mitre_deprecated === true, we will skip this objects when ignoreDeprecated is true
      if (ignoreDeprecated && STIXObject.x_mitre_deprecated) {
        ignoredObjects++;
        continue;
      }

      // type !== relationship && not in excludeIds
      if (
        STIXObjectType !== 'relationship' &&
        !excludeIds.includes(STIXObject.id)
      ) {
        if (STIXObject.object_marking_refs) {
          STIXObjectsWithMarkingRefs.push(STIXObject);
        }

        STIXEntityQueryList.add(
          this.generateSTIXQuery(STIXObject, STIXObjectType),
        );
      }
    }

    const markingRelationsQueryList = this.markingRelations(
      STIXObjectsWithMarkingRefs,
    );
    logger.info(`Skipped ${ignoredObjects} deprecated objects`);
    logger.info(
      `Generated ${STIXEntityQueryList.size} insert queries for STIXObjects`,
    );
    logger.info(
      `Generated ${markingRelationsQueryList.size} insert queries for marking relations`,
    );
    return {
      STIXEntityQueryList: [...STIXEntityQueryList],
      markingRelations: [...markingRelationsQueryList],
    };
  }

  generateSTIXQuery(STIXObject: STIXObject, STIXObjectType: string): Query {
    const STIXMap = STIXEntityToTypeDB(STIXObjectType);
    let query: Query;

    if (STIXMap.customType) {
      query = `$stix isa custom-object, has stix-type '${STIXMap.type}'`;
    } else {
      let entityType: string;

      if (STIXMap.type === 'identity') {
        entityType = STIXObject.identity_class;
      } else {
        entityType = STIXObject.type;
      }
      query = `$stix isa ${entityType}`;
    }
    query = `
      insert
        ${query},
        ${this.attribute(STIXObject)};
    `;

    if (STIXObject.created_by_ref) {
      // We expect creating STIX objects to be inserted before
      query = `
        match
          $creator isa thing, has stix-id '${STIXObject.created_by_ref}';
        ${query}
        (created: $stix, creator: $creator) isa creation;
      `;
    }

    return query;
  }

  markingRelations(STIXObjectsWithMarkingRefs: STIXObject[]): Set<Query> {
    const queryList: Set<Query> = new Set();

    for (const STIXObject of STIXObjectsWithMarkingRefs) {
      queryList.add(`
        match
          $x isa thing, has stix-id '${STIXObject.id}';
          $marking isa marking-definition,
            has stix-id '${STIXObject.object_marking_refs[0]}';
        insert
          (marked: $x, marking: $marking) isa object-marking;
      `);
    }

    return queryList;
  }

  attribute(STIXObject: STIXObject): Query {
    let query: Query = '';
    const typeDBAttributes: STIXAttributeMapper = STIXAttributesToTypeDB();

    for (const [STIXKey, typeQLDefinition] of Object.entries(
      typeDBAttributes,
    )) {
      if (STIXKey in STIXObject) {
        const typeQLAttributeType = typeQLDefinition.type;
        const STIXValueType = typeQLDefinition.value;
        const STIXValue: string | string[] = STIXObject[STIXKey];

        switch (STIXValueType) {
          case 'string':
            query += ` has ${typeQLAttributeType} '${STIXValue.replace(/'/g, '"')}',`;
            break;
          case 'boolean':
            query += ` has ${typeQLAttributeType} ${STIXValue},`;
            break;
          case 'list':
            for (const value of STIXValue) {
              query += ` has ${typeQLAttributeType} '${value}',`;
            }
            break;
        }
      }
    }

    return query.slice(1, -1);
  }
}

export default STIXInsertGenerator;
