// Script pour créer les index MongoDB optimaux
// À exécuter une seule fois dans votre console MongoDB ou via un script

use schrift;

// Index pour la recherche par nom
db.characters.createIndex({ "search_name": "text", "name": "text" });

// Index pour search_name (recherche exacte et partielle)
db.characters.createIndex({ "search_name": 1 });

// Index pour l'affinité
db.characters.createIndex({ "affinity": 1 });

// Index composé pour les recherches complexes
db.characters.createIndex({ "affinity": 1, "search_name": 1 });

// Index pour les catégories
db.characters.createIndex({ "categories": 1 });

// Vérifier les index créés
db.characters.getIndexes();

console.log("Index créés avec succès !");
console.log("Ces index vont accélérer considérablement les requêtes sur 2000+ personnages.");