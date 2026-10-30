// Trimmed Spring Boot 3 Actuator responses, for tests and the live check's fake app.
export const health = { status: 'UP', components: { db: { status: 'UP', details: { database: 'PostgreSQL' } }, diskSpace: { status: 'UP' }, payments: { status: 'DOWN', details: { error: 'timeout' } } } };
export const env = { activeProfiles: ['local'], propertySources: [
  { name: 'Config resource \'class path resource [application-local.yml]\'', properties: { 'server.port': { value: 8080, origin: 'application-local.yml - 1:9' }, 'spring.datasource.url': { value: 'jdbc:postgresql://localhost/pets' } } },
  { name: 'Config resource \'class path resource [application.yml]\'', properties: { 'server.port': { value: 9090 }, 'app.secret': { value: '******' } } },
] };
export const mappings = { contexts: { application: { mappings: { dispatcherServlets: { dispatcherServlet: [
  { handler: 'com.example.pets.PetController#list()', predicate: '{GET [/api/pets]}', details: { handlerMethod: { className: 'com.example.pets.PetController', name: 'list' }, requestMappingConditions: { methods: ['GET'], patterns: ['/api/pets'], produces: [{ mediaType: 'application/json', negated: false }], consumes: [], params: [], headers: [] } } },
  { handler: 'com.example.pets.PetController#get(Long)', details: { handlerMethod: { className: 'com.example.pets.PetController', name: 'get' }, requestMappingConditions: { methods: ['GET'], patterns: ['/api/pets/{id}'], produces: [], consumes: [], params: [], headers: [] } } },
  { handler: 'com.example.pets.PetController#create(Pet)', details: { handlerMethod: { className: 'com.example.pets.PetController', name: 'create' }, requestMappingConditions: { methods: ['POST'], patterns: ['/api/pets'], produces: [], consumes: [{ mediaType: 'application/json' }], params: [], headers: [] } } },
  { handler: 'com.example.orders.OrderController#find(String)', details: { handlerMethod: { className: 'com.example.orders.OrderController', name: 'find' }, requestMappingConditions: { methods: [], patterns: ['/api/orders/{orderId:[0-9]+}'], produces: [], consumes: [], params: [], headers: [] } } },
  { handler: 'org.springframework.boot.autoconfigure.web.servlet.error.BasicErrorController#error(HttpServletRequest)', details: { handlerMethod: { className: 'org.springframework.boot.autoconfigure.web.servlet.error.BasicErrorController', name: 'error' }, requestMappingConditions: { methods: [], patterns: ['/error'], produces: [], consumes: [], params: [], headers: [] } } },
  { handler: 'Actuator web endpoint \'health\'', details: { requestMappingConditions: { methods: ['GET'], patterns: ['/actuator/health'], produces: [], consumes: [], params: [], headers: [] } } },
  { handler: 'ResourceHttpRequestHandler [classpath [static/]]', predicate: '/**' },
] } } } } };
export const loggers = { levels: ['OFF', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'], loggers: { ROOT: { configuredLevel: 'INFO', effectiveLevel: 'INFO' }, com: { effectiveLevel: 'INFO' }, 'com.example': { effectiveLevel: 'INFO' }, 'org.hibernate.SQL': { configuredLevel: 'WARN', effectiveLevel: 'WARN' } }, groups: {} };
