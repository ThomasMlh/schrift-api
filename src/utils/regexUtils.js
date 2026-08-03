// Échappe les métacaractères regex d'une chaîne fournie par l'utilisateur avant de l'utiliser
// dans un $regex MongoDB — sans ça, un pseudo comme "[FR]Whitep" ou "(Nun)" est interprété comme
// un pattern regex (classe de caractères / groupe) au lieu du texte littéral, et ne matche rien.
export const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
