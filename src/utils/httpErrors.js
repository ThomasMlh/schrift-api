// Réponses d'erreur 500 génériques, mutualisées pour ne plus dupliquer le
// même `res.status(500).json(...)` dans chaque bloc catch de route.
//
// Ces deux formes correspondent aux deux formats déjà utilisés par la
// majorité des routes existantes ; on ne les fusionne pas en un seul format
// pour ne rien changer côté frontend (chaque route garde exactement la même
// forme de réponse qu'avant).
export const sendServerError = (res, err) =>
  res.status(500).json({ error: err.message });

export const sendServerErrorWithFlag = (res, err) =>
  res.status(500).json({ success: false, error: err.message });
